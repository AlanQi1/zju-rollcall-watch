/**
 * 虚拟位置点位库（雷达点名应答用）。
 *
 * 内置 12 个浙大常用点位（WGS84）；自定义点位保存在本地 locations.json。
 * 只读监听无需配置，开启自动签到后可选择预设点位或填写自定义经纬度。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 地球平均半径（米）。 */
export const EARTH_RADIUS_M = 6371008.8;

/** 浙大常用点位（WGS84）。 */
export const PRESET_LOCATIONS = [
  { id: 'zjg-dong1', name: '东一教学楼', campus: '紫金港', lon: 120.089136, lat: 30.302331, aliases: ['东一', '东1', '紫金港东一'] },
  { id: 'zjg-xi', name: '西教学楼', campus: '紫金港', lon: 120.085042, lat: 30.30173, aliases: ['西教', '西1', '紫金港西教'] },
  { id: 'zjg-duanyongping', name: '段永平教学楼', campus: '紫金港', lon: 120.077135, lat: 30.305142, aliases: ['段永平', '段楼', '大西区教学楼'] },
  { id: 'yq-jiao4', name: '玉泉教四', campus: '玉泉', lon: 120.122176, lat: 30.261555, aliases: ['教四', '玉泉第四教学楼'] },
  { id: 'yq-jiao1', name: '玉泉教一', campus: '玉泉', lon: 120.123853, lat: 30.262544, aliases: ['教一', '玉泉第一教学楼'] },
  { id: 'yq-jiao7', name: '玉泉教七', campus: '玉泉', lon: 120.120344, lat: 30.263907, aliases: ['教七', '玉泉第七教学楼'] },
  { id: 'zj-campus1', name: '之江校区1', campus: '之江', lon: 120.126008, lat: 30.192908, aliases: ['之江1'] },
  { id: 'hjc-campus1', name: '华家池校区1', campus: '华家池', lon: 120.195939, lat: 30.272068, aliases: ['华家池1'] },
  { id: 'hjc-campus2', name: '华家池校区2', campus: '华家池', lon: 120.198193, lat: 30.270419, aliases: ['华家池2'] },
  { id: 'zj-campus2', name: '之江校区2', campus: '之江', lon: 120.124267, lat: 30.19139, aliases: ['之江2'] },
  { id: 'yq-sushe', name: '玉泉宿舍', campus: '玉泉', lon: 120.124001, lat: 30.265735, aliases: ['宿舍', '玉泉学生宿舍'] },
  { id: 'zjg-daxiqu', name: '紫金港大西区', campus: '紫金港', lon: 120.073427, lat: 30.299757, aliases: ['大西区'] },
];

/** 保留 6 位小数（约 0.11 米）。 */
export function roundCoordinate(value) {
  return Number(Number(value).toFixed(6));
}

export function formatPoint(point) {
  if (!point) return '';
  return `${roundCoordinate(point.lon)},${roundCoordinate(point.lat)}`;
}

/** 校验并归一化经纬度。 */
export function normalizePoint(lon, lat) {
  const lonNumber = Number(lon);
  const latNumber = Number(lat);
  if (!Number.isFinite(lonNumber) || !Number.isFinite(latNumber)) {
    throw new Error('经纬度必须是数字，例如 120.089136,30.302331');
  }
  if (lonNumber < -180 || lonNumber > 180) throw new Error(`经度 ${lonNumber} 超出 -180~180，格式是「经度,纬度」`);
  if (latNumber < -90 || latNumber > 90) throw new Error(`纬度 ${latNumber} 超出 -90~90，格式是「经度,纬度」`);
  return { lon: roundCoordinate(lonNumber), lat: roundCoordinate(latNumber) };
}

/** 解析「经度,纬度」文本；写反了会自动纠正。 */
export function parseCoordinateText(text) {
  const source = String(text ?? '').trim();
  if (!source) return null;
  const match = source.match(/^(-?\d{1,3}(?:\.\d+)?)\s*[,，\s]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!match) return null;
  const first = Number(match[1]);
  const second = Number(match[2]);
  if (!Number.isFinite(first) || !Number.isFinite(second)) return null;
  if (Math.abs(first) <= 90 && Math.abs(second) > 90) return normalizePoint(second, first);
  return normalizePoint(first, second);
}

/** 球面大圆距离（米）。 */
export function haversineMeters(a, b) {
  const toRad = (value) => (Number(value) * Math.PI) / 180;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = lat2 - lat1;
  const dLon = toRad(Number(b.lon) - Number(a.lon));
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function normalizeKey(value) {
  return String(value ?? '').replace(/[\s\u3000]+/g, '').toLowerCase();
}

/** 点位库。 */
export class LocationStore {
  constructor(dataDir) {
    this.file = join(dataDir, 'locations.json');
    this.presets = PRESET_LOCATIONS.map((item) => ({ ...item, aliases: [...(item.aliases || [])], preset: true }));
    this.data = null;
  }

  load() {
    if (this.data) return this.data;
    let parsed = null;
    if (existsSync(this.file)) {
      try {
        parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      } catch {
        parsed = null;
      }
    }
    this.data = {
      version: 1,
      defaultId: parsed?.defaultId || null,
      locations: Array.isArray(parsed?.locations) ? parsed.locations : [],
    };
    return this.data;
  }

  save() {
    const data = this.load();
    mkdirSync(join(this.file, '..'), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }

  /** 全部点位（自定义在前，同名优先）。 */
  all() {
    const data = this.load();
    const custom = data.locations.map((item) => ({ ...item, preset: false }));
    const taken = new Set(custom.map((item) => normalizeKey(item.name)));
    const presets = this.presets.filter((item) => !taken.has(normalizeKey(item.name)));
    return [...custom, ...presets];
  }

  /** 按 id / 名称 / 别名 / 坐标解析点位。 */
  resolve(idOrName) {
    const source = String(idOrName ?? '').trim();
    if (!source) return null;
    const coords = parseCoordinateText(source);
    if (coords) return { id: 'coords', name: `坐标 ${formatPoint(coords)}`, campus: '', ...coords };
    const key = normalizeKey(source);
    const list = this.all();
    const exact = list.find((item) => normalizeKey(item.id) === key || normalizeKey(item.name) === key);
    if (exact) return exact;
    const alias = list.find((item) => (item.aliases || []).some((name) => normalizeKey(name) === key));
    if (alias) return alias;
    const fuzzy = list.filter(
      (item) =>
        normalizeKey(item.name).includes(key) ||
        (item.aliases || []).some((name) => normalizeKey(name).includes(key)),
    );
    if (fuzzy.length === 1) return fuzzy[0];
    return null;
  }

  /** 默认点位：先看库里设置的 defaultId，再看账号自身配置。 */
  defaultLocation() {
    const data = this.load();
    if (!data.defaultId) return null;
    return this.all().find((item) => item.id === data.defaultId) || null;
  }

  setDefault(idOrName) {
    const found = this.resolve(idOrName);
    if (!found) throw new Error(`找不到点位：${idOrName}`);
    if (found.id === 'coords') throw new Error('默认点位必须来自点位库，请先 add 一个点位。');
    const data = this.load();
    data.defaultId = found.id;
    this.save();
    return found;
  }

  /** 新增或更新自定义点位。 */
  add({ name, lon, lat, campus = '', aliases = [] }) {
    const point = normalizePoint(lon, lat);
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new Error('点位需要一个名字');
    const data = this.load();
    const id = `c-${normalizeKey(cleanName).replace(/[^\w\u4e00-\u9fa5-]/g, '').slice(0, 20) || 'point'}`;
    const entry = {
      id,
      name: cleanName,
      campus: String(campus || '').trim(),
      lon: point.lon,
      lat: point.lat,
      aliases: Array.isArray(aliases) ? aliases : [],
    };
    const index = data.locations.findIndex((item) => item.id === id || normalizeKey(item.name) === normalizeKey(cleanName));
    if (index >= 0) data.locations[index] = entry;
    else data.locations.push(entry);
    this.save();
    return entry;
  }

  remove(idOrName) {
    const found = this.resolve(idOrName);
    if (!found) throw new Error(`找不到点位：${idOrName}`);
    const data = this.load();
    const before = data.locations.length;
    data.locations = data.locations.filter((item) => item.id !== found.id && normalizeKey(item.name) !== normalizeKey(found.name));
    if (data.defaultId === found.id) data.defaultId = null;
    this.save();
    return before !== data.locations.length;
  }

  /** 面板快照。 */
  snapshot() {
    const data = this.load();
    const list = this.all().map((item) => ({ ...item, isDefault: item.id === data.defaultId }));
    return {
      file: this.file,
      defaultId: data.defaultId,
      default: list.find((item) => item.isDefault) || null,
      count: list.length,
      locations: list,
    };
  }

  /**
   * 应答时的候选序列：指定点 → 默认点 → 其余点位 → （可选）三点定位推算。
   * @param {string} [preferred] 账号自带的点位名
   */
  candidates(preferred) {
    const seen = new Set();
    const out = [];
    const push = (item, role) => {
      if (!item) return;
      const key = `${roundCoordinate(item.lon)},${roundCoordinate(item.lat)}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ ...item, role });
    };
    if (preferred) push(this.resolve(preferred), 'account');
    push(this.defaultLocation(), 'default');
    for (const item of this.all()) push(item, 'fallback');
    return out;
  }
}
