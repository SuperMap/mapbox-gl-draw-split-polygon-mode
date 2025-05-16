import lineIntersect from "@turf/line-intersect";
import booleanDisjoint from "@turf/boolean-disjoint";
import lineOffset from "@turf/line-offset";
import lineToPolygon from "@turf/line-to-polygon";
import difference from "@turf/difference";
import { lineString, polygon, multiPolygon } from "@turf/helpers";
import buffer from "@turf/buffer";
import { getCoords } from "@turf/invariant";
import * as martinez from 'martinez-polygon-clipping';

import {
  modeName,
  passingModeName,
  highlightPropertyName,
  defaultOptions,
} from "./constants";

export const geojsonTypes = {
  FEATURE: 'Feature',
  FEATURE_COLLECTION: 'FeatureCollection',
  POLYGON: 'Polygon',
  LINE_STRING: 'LineString',
  POINT: 'Point'
};

const SplitPolygonMode = {};

SplitPolygonMode.onSetup = function (opt) {
  const {
    featureIds = [],
    highlightColor = defaultOptions.highlightColor,
    lineWidth = defaultOptions.lineWidth,
    lineWidthUnit = defaultOptions.lineWidthUnit,
    onSelectFeatureRequest = defaultOptions.onSelectFeatureRequest,
  } = opt || {};

  const api = this._ctx.api;

  const featuresToSplit = [];
  const selectedFeatures = this.getSelected();

  if (featureIds.length !== 0) {
    featuresToSplit.push.apply(
      featuresToSplit,
      featureIds.map((id) => api.get(id))
    );
  } else if (selectedFeatures.length !== 0) {
    featuresToSplit.push.apply(
      featuresToSplit,
      selectedFeatures
        .filter(
          (f) =>
            f.type === geojsonTypes.POLYGON ||
            f.type === geojsonTypes.MULTI_POLYGON
        )
        .map((f) => f.toGeoJSON())
    );
  } else {
    return onSelectFeatureRequest();
  }

  const state = {
    options: {
      highlightColor,
      lineWidth,
      lineWidthUnit,
    },
    featuresToSplit,
    api,
  };

  /// `onSetup` job should complete for this mode to work.
  /// so `setTimeout` is used to bupass mode change after `onSetup` is done executing.
  setTimeout(this.drawAndSplit.bind(this, state), 0);
  this.highlighFeatures(state);

  return state;
};

SplitPolygonMode.drawAndSplit = function (state) {
  const { api, options } = state;
  const { lineWidth, lineWidthUnit } = options;

  try {
    this.changeMode(passingModeName, {
      onDraw: (cuttingLineString) => {
        const newPolygons = [];
        state.featuresToSplit.filter(Boolean).forEach((el) => {
          if (booleanDisjoint(el, cuttingLineString)) {
            console.info(`Line was outside of Polygon ${el.id}`);
            newPolygons.push(el);
            return;
          } else if (lineWidth === 0) {
            const polycut = polygonCut(el.geometry, cuttingLineString.geometry);
            polycut.id = el.id;
            api.add(polycut);
            newPolygons.push(polycut);
          } else {
            const polycut = polygonCutWithSpacing(
              el.geometry,
              cuttingLineString.geometry,
              {
                line_width: lineWidth,
                line_width_unit: lineWidthUnit,
              }
            );
            polycut.id = el.id;
            api.add(polycut);
            newPolygons.push(polycut);
          }
        });

        this.fireUpdate(newPolygons);
        this.highlighFeatures(state, false);
      },
      onCancel: () => {
        this.highlighFeatures(state, false);
      },
    });
  } catch (err) {
    console.error("🚀 ~ file: mode.js ~ line 116 ~ err", err);
  }
};

SplitPolygonMode.highlighFeatures = function (state, shouldHighlight = true) {
  const color = shouldHighlight ? state.options.highlightColor : undefined;

  state.featuresToSplit.filter(Boolean).forEach((f) => {
    state.api.setFeatureProperty(f.id, highlightPropertyName, color);
  });
};

SplitPolygonMode.toDisplayFeatures = function (state, geojson, display) {
  display(geojson);
};

SplitPolygonMode.fireUpdate = function (newF) {
  this.map.fire('draw.update', {
    action: modeName,
    features: newF,
  });
};

// SplitPolygonMode.onStop = function ({ main }) {
//   console.log("🚀 ~ file: mode.js ~ line 60 ~ onStop");
// };

export default SplitPolygonMode;

function createThinLinePolygon(lineFeature, halfWidth) {
  const left = lineOffset(lineFeature, -halfWidth, { units: 'meters' });
  const right = lineOffset(lineFeature, halfWidth, { units: 'meters' });

  const coords = [
    ...left.geometry.coordinates,
    ...right.geometry.coordinates.slice().reverse()
  ];
  coords.push(coords[0]); // 闭合
  return polygon([coords], lineFeature.properties);
}

function splitPolygonWithLine(polygonFeature, lineFeature) {
  const buf = createThinLinePolygon(lineFeature, 0.0005); 
  // buffer方法更消耗性能
  // const safeMinRadius = 0.001; // 1毫米
  // const buf = buffer(lineFeature, safeMinRadius, { units: 'meters' });
  const polyCoords = getCoords(polygonFeature);
  const bufferCoords = getCoords(buf);
  
  const clipped = martinez.diff(polyCoords, bufferCoords); // 参数1 原始多边形 参数2 缓冲区多边形，结果是原始多边形减去缓冲区多边形后剩下的部分

  if (!clipped || clipped.length === 0) {
    return multiPolygon([]);
  }
  // clipped 是一个 MultiPolygon 结构，所以先遍历每个多边形
  const multiPolygonCoords = clipped.map(rings => {
    // 每个多边形由一个外环和可能的内环（孔洞）组成
    // Martinez 裁剪库的结果（clipped）不一定保证闭环 所以以下判断必要
    const closedRings = rings.map(ring => {
      if (ring.length < 3) return null;  // 至少需要3个点才能形成多边形
      const first = ring[0];
      const last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) {
        ring.push([first[0], first[1]]); // 如果环未闭合，添加第一个点来闭合它
      }
      return ring;
    }).filter(Boolean);

    return closedRings.length > 0 ? closedRings : null;
  }).filter(Boolean);

  return multiPolygon(multiPolygonCoords);
}

/// Note: currently has some issues, but generally is a better approach
function polygonCut(polyGeom, lineGeom) {
  // 根据几何类型创建对应的Turf要素
  let polyFeature;
  if (polyGeom.type === 'Polygon') {
    polyFeature = polygon(polyGeom.coordinates);
  } else if (polyGeom.type === 'MultiPolygon') {
    polyFeature = multiPolygon(polyGeom.coordinates);
  } else {
    throw new Error('Unsupported geometry type for cutting');
  }
  const lineFeature = lineString(lineGeom.coordinates);
  const result = splitPolygonWithLine(polyFeature, lineFeature);
  return result;
}

/// Adopted from https://gis.stackexchange.com/a/344277/145409
function polygonCutWithSpacing(poly, line, options) {
  const { line_width, line_width_unit } = options || {};

  const offsetLine = [];
  const retVal = null;
  let i, j, intersectPoints, forCut, forSelect;
  let thickLineString, thickLinePolygon, clipped;

  if (
    typeof line_width === "undefined" ||
    typeof line_width_unit === "undefined" ||
    (poly.type != geojsonTypes.POLYGON &&
      poly.type != geojsonTypes.MULTI_POLYGON) ||
    line.type != geojsonTypes.LINE_STRING
  ) {
    return retVal;
  }

  /// if line and polygon don't intersect return.
  if (booleanDisjoint(line, poly)) {
    return retVal;
  }

  intersectPoints = lineIntersect(poly, line);
  if (intersectPoints.features.length === 0) {
    return retVal;
  }

  /// Creating two new lines at sides of the splitting lineString
  offsetLine[0] = lineOffset(line, line_width, {
    units: line_width_unit,
  });
  offsetLine[1] = lineOffset(line, -line_width, {
    units: line_width_unit,
  });

  for (i = 0; i <= 1; i++) {
    forCut = i;
    forSelect = (i + 1) % 2;
    const polyCoords = [];
    for (j = 0; j < line.coordinates.length; j++) {
      polyCoords.push(line.coordinates[j]);
    }
    for (j = offsetLine[forCut].geometry.coordinates.length - 1; j >= 0; j--) {
      polyCoords.push(offsetLine[forCut].geometry.coordinates[j]);
    }
    polyCoords.push(line.coordinates[0]);

    thickLineString = lineString(polyCoords);
    thickLinePolygon = lineToPolygon(thickLineString);
    clipped = difference(poly, thickLinePolygon);
  }

  return clipped;
}
