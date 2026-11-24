/**
 * 三点定位（球面线性最小二乘）。
 *
 * 把每个信标点转成地心单位向量 u_i，目标点 u 满足 u · u_i = cos(d_i / R)；
 * 这是关于 u 的线性方程组，3 个以上信标即可求解，解出来归一化到单位球面。
 */
import { EARTH_RADIUS_M, haversineMeters, roundCoordinate } from './locations.js';

const MAX_POINTS = 12;

/** 解 3×3 线性方程组（高斯消元 + 部分主元）。 */
function solveLinear3(matrix, vector) {
  const rows = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    }
    if (!Number.isFinite(rows[pivot][column]) || Math.abs(rows[pivot][column]) < 1e-12) return null;
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    for (let cell = column; cell < 4; cell += 1) rows[column][cell] /= divisor;
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue;
      const factor = rows[row][column];
      if (!factor) continue;
      for (let cell = column; cell < 4; cell += 1) rows[row][cell] -= factor * rows[column][cell];
    }
  }
  return [rows[0][3], rows[1][3], rows[2][3]];
}

/**
 * @param {Array<{lon:number, lat:number, d:number}>} rawPoints
 * @returns {{lon:number, lat:number, rms:number, points:number, reliable:boolean}|null}
 */
export function estimatePosition(rawPoints) {
  const points = (Array.isArray(rawPoints) ? rawPoints : [])
    .filter(
      (p) =>
        p &&
        Number.isFinite(Number(p.lon)) &&
        Number.isFinite(Number(p.lat)) &&
        Number.isFinite(Number(p.d)) &&
        Number(p.d) > 0,
    )
    .slice(0, MAX_POINTS)
    .map((p) => ({ lon: Number(p.lon), lat: Number(p.lat), d: Number(p.d) }));
  if (points.length < 3) return null;

  const toVector = (lon, lat) => {
    const lambda = (lon * Math.PI) / 180;
    const phi = (lat * Math.PI) / 180;
    return [Math.cos(phi) * Math.cos(lambda), Math.cos(phi) * Math.sin(lambda), Math.sin(phi)];
  };

  const matrix = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const vector = [0, 0, 0];
  for (const point of points) {
    const unit = toVector(point.lon, point.lat);
    const cosine = Math.cos(point.d / EARTH_RADIUS_M);
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) matrix[row][column] += unit[row] * unit[column];
      vector[row] += unit[row] * cosine;
    }
  }

  const solved = solveLinear3(matrix, vector);
  if (!solved) return null;
  const norm = Math.hypot(solved[0], solved[1], solved[2]);
  if (!Number.isFinite(norm) || norm < 1e-9) return null;
  const unit = solved.map((value) => value / norm);
  const lat = (Math.asin(Math.max(-1, Math.min(1, unit[2]))) * 180) / Math.PI;
  const lon = (Math.atan2(unit[1], unit[0]) * 180) / Math.PI;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;

  const rms = Math.sqrt(
    points.reduce((sum, point) => {
      const delta = point.d - haversineMeters({ lon, lat }, point);
      return sum + delta * delta;
    }, 0) / points.length,
  );

  const anchor = {
    lon: points.reduce((sum, p) => sum + p.lon, 0) / points.length,
    lat: points.reduce((sum, p) => sum + p.lat, 0) / points.length,
  };
  const offset = haversineMeters(anchor, { lon, lat });
  const reliable = Math.abs(norm - 1) <= 0.2 && rms <= 150 && offset <= 50000;

  return {
    lon: roundCoordinate(lon),
    lat: roundCoordinate(lat),
    rms: Math.round(rms * 10) / 10,
    points: points.length,
    reliable,
  };
}

/** 从应答 JSON 里提取距离（米）。 */
export function extractDistance(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const candidates = [
    payload.distance,
    payload.data?.distance,
    payload.result?.distance,
    payload.rollcall?.distance,
    payload.distance_in_meters,
  ];
  for (const value of candidates) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

export function extractErrorCode(payload) {
  if (!payload || typeof payload !== 'object') return '';
  return String(
    payload.error_code || payload.errorCode || payload.data?.error_code || payload.result?.error_code || '',
  );
}

/** 判断一次雷达应答是否成功。 */
export function rollcallAnswerSucceeded(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const status = String(payload.status_name || payload.status || '');
  if (status === 'on_call_fine' || status === 'present') return true;
  if (payload.success === true) return true;
  return false;
}
