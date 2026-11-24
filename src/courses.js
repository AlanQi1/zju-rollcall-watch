/** 学在浙大点名客户端。自动签到由独立开关和 AutoSigner 控制。 */
import { randomUUID } from 'node:crypto';
import { request } from './http.js';
export const COURSES = 'https://courses.zju.edu.cn';
export function shanghaiDateTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = typeof value === 'number' ? (value > 1e12 ? value : value * 1000) : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
export class CoursesClient {
  constructor(jar, options = {}) { this.jar = jar; this.timeoutMs = options.timeoutMs ?? 20000; }
  async json(path, options = {}) {
    const headers = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const result = await request(this.jar, `${COURSES}${path}`, { method: options.method || 'GET', headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) }, { follow: false, timeoutMs: this.timeoutMs });
    const text = await result.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 登录页不是 JSON */ }
    return { status: result.res.status, json, text };
  }
  async todos() { return this.json('/api/todos?page=1&page_size=1'); }
  async answerRadar(rollcallId, point = {}) {
    if (rollcallId === null || rollcallId === undefined || String(rollcallId).trim() === '') throw new Error('缺少签到编号');
    const lon = Number(point.lon), lat = Number(point.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) throw new Error('签到位置经纬度无效');
    return this.json(`/api/rollcall/${encodeURIComponent(rollcallId)}/answer?api_version=1.1.2`, {
      method: 'PUT', body: { deviceId: point.deviceId || randomUUID(), latitude: lat, longitude: lon, accuracy: 68, speed: null, altitude: null, altitudeAccuracy: null, heading: null },
    });
  }
  async rollcalls() {
    const r = await this.json('/api/radar/rollcalls');
    if (r.status !== 200 || !r.json) throw new Error(`签到查询失败（HTTP ${r.status}），请检查网络或重新登录`);
    if (!Array.isArray(r.json.rollcalls)) throw new Error('签到接口响应结构异常：缺少 rollcalls 列表');
    const signed = new Set(['on_call', 'on_call_fine', 'present', 'signed', 'signed_in']);
    return r.json.rollcalls.map((item) => {
      const handled = signed.has(String(item.status || '').toLowerCase()) || signed.has(String(item.rollcall_status || '').toLowerCase());
      const expired = item.is_expired === true || item.is_expired === 1;
      return {
        id: item.rollcall_id, title: item.title || '', courseId: item.course_id ?? null,
        courseTitle: item.course_title || '', teacher: item.created_by_name || '', department: item.department_name || '',
        type: item.is_radar ? '雷达点名' : item.is_number ? '数字点名' : item.source === 'qrcode' ? '二维码签到' : '课堂签到',
        isRadar: Boolean(item.is_radar), isNumber: Boolean(item.is_number), source: item.source || '',
        startedAt: item.rollcall_time ? shanghaiDateTime(item.rollcall_time) : null,
        expired, handled, active: !expired && !handled, myStatus: item.status || '',
        url: item.course_id ? `${COURSES}/course/${encodeURIComponent(item.course_id)}/learning-activity` : `${COURSES}/user/index`,
      };
    });
  }
}
