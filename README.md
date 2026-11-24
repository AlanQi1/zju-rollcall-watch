# 签到雷达（Rollcall Radar）

基于 Electron 的独立 Windows 桌面应用：实时监听「学在浙大」当前进行中的课堂点名，支持系统托盘常驻、圆角玻璃置顶弹窗提醒，以及可配置的雷达点名自动签到。

> 本项目完全开源、零后端服务器，所有网络请求仅直连 `*.zju.edu.cn`，账号与密码仅保存在本机 `accounts.env` 文件中。

## 主要功能

- **一键单文件运行**：打包为单个 Windows 便携 `.exe`，双击即可运行，无需安装 Node.js 或解压零散目录。
- **程序内账号管理（本地 `.env` 存储）**：
  - 首页与「账号」页面均提供 **添加账号** 入口，支持多账号添加、编辑、启停与删除。
  - 账号与密码统一以标准 `.env` 格式保存在本地 `accounts.env` 文件中（程序内置 **打开 `accounts.env`** 与 **打开配置目录** 按钮）。
  - 界面与日志对学号自动脱敏，密码永不写入日志。
- **实时监听与系统托盘**：
  - 默认每 30 秒查询一次（可选 15 秒 / 30 秒 / 60 秒 / 2 分钟），关闭主窗口后自动收起到系统托盘继续后台运行。
  - 支持 Windows 开机自动启动，休眠唤醒后自动补查。
  - 自动配置 `NO_PROXY`，避免本地代理工具干扰校园网直连。
- **玻璃置顶提醒**：
  - 发现新签到时在屏幕右下角弹出置顶玻璃卡片，不抢占当前输入焦点；支持提示音与自定义停留时间（鼠标悬停暂停倒计时）。
  - 内置「测试提醒」按钮，明确标注非真实签到，用于验证弹窗与声音效果。
- **可选雷达自动签到（默认关闭）**：
  - 默认仅提醒，不自动代签；可在「设置 → 自动签到（雷达点名）」中按需开启。
  - 内置 12 个浙大常用教学楼点位（WGS84），支持自定义 `经度,纬度`，并支持按账号单独指定点位或单独退出自动签到。
  - 严格状态确认：只有平台明确返回已签到或回读确认已签才标记成功，结果支持跨重启去重。

## 快速开始

### 方式一：直接运行单文件 `.exe`

1. 下载或构建生成的单文件可执行程序：`RollcallRadar-2.2.0-Windows-x64.exe`。
2. 双击运行，点击首页或「账号」页面的 **「添加账号」**，输入浙大学号与 ZJUAM 密码并保存。
3. 账号信息将自动写入本机 `accounts.env`（默认位于 `%APPDATA%\ZjuRollcallWatch\accounts.env`），随即开始监听。

> 若需要手动指定 `.env` 文件，也可以直接将 `accounts.env` 或 `.env` 放在 `.exe` 同级目录，或通过环境变量 `ROLLCALL_ENV_FILE` 指定路径。格式参考 [.env.example](.env.example)。

### 方式二：从源码运行与打包

环境要求：Node.js 20+（推荐 22/24）、Windows 10/11。

```bash
# 1. 安装依赖
npm install

# 2. 启动桌面应用（开发模式，数据保存在项目 data/ 目录，已加入 .gitignore）
npm start

# 3. 运行单元测试（114+ 项，纯本地模拟，不请求学校接口）
npm test

# 4. 运行桌面端到端自测（独立临时目录 + 模拟客户端）
npm run test:desktop

# 5. 打包为单个便携版 .exe（输出到 release/RollcallRadar-2.2.0-Windows-x64.exe）
npm run build

# 6. 验证打包后的单文件 .exe 并运行隐私/产物审计
npm run test:exe
npm run audit:release
```

## 本地配置与环境变量

| 配置文件 | 说明 |
| --- | --- |
| `accounts.env` | 本地账号凭据（标准 `.env` 格式），由程序内「添加/编辑/删除账号」自动维护 |
| `config.json` | 监听间隔、弹窗、提示音、自动签到开关与全局默认点位 |
| `auto-sign.json` | 自动签到记录与去重状态（不含密码与完整学号） |
| `reminded.json` | 普通弹窗提醒去重记录 |

支持的环境变量字段（详见 [.env.example](.env.example)）：

```env
ZJU_USER=你的学号
ZJU_PASSWORD=你的密码
ZJU_LABEL=主账号
ZJU_LOCATION=东一教学楼
ZJU_ENABLED=true
ZJU_AUTO_ANSWER=true
```

多账号可使用 `_2`、`_3` 等数字后缀（如 `ZJU_USER_2`、`ZJU_PASSWORD_2`）。

## 隐私与安全说明

- **本地存储**：账号密码仅保存在本机 `accounts.env` 中；`.gitignore` 已默认忽略 `.env`、`accounts.env`、`data/`、`release/` 等所有本地文件，防止开源提交时误传敏感信息。
- **网络白名单**：HTTP 客户端强制校验目标主机必须为 `*.zju.edu.cn`，拒绝任何非浙大域名请求与跨站跳转。
- **内存会话**：登录后的会话 Cookie 仅保存在进程内存中，不落盘、不输出日志。
- **开源构建白名单**：`package.json` 中的 `build.files` 严格按白名单打包应用源码，确保生成的 `.exe` 不包含任何本地配置、日志或凭据。

## 致谢

本项目的部分关键思路与点位数据参考自以下开源项目，特此致谢：

- **[ZJU-live-better](https://github.com/5dbwat4/ZJU-live-better)**（`GPL-3.0-only`）— 雷达点名内置的 12 个教学楼信标点位（`src/locations.js`）与基于距离回读的三点定位反推思路（`src/trilateration.js`）源自该项目。
- **[login-zju](https://github.com/5dbwat4/login-zju)** — ZJUAM 统一身份认证（CAS）登录流程与 RSA 公钥加密细节的参考实现。

## 开源协议与免责声明

本项目采用 **[GNU General Public License v3.0 (GPL-3.0-only)](LICENSE)** 开源协议，Copyright (C) 2026 AlanQi1。

因本项目的雷达点位数据与定位算法衍生自以 GPL-3.0 协议发布的 [ZJU-live-better](https://github.com/5dbwat4/ZJU-live-better)，遵循该协议的传染性（Copyleft）要求，本项目同样以 `GPL-3.0-only` 发布。任何修改与再分发（包括二进制可执行文件分发）均须遵循 GPL-3.0 条款、保留原版权与许可声明并提供对应源代码。

本项目仅供学习交流与课堂签到提醒辅助使用，请勿用于任何商业用途；自动签到功能默认关闭，使用前请自行了解并遵守学校及课程相关规定，因使用本项目产生的一切后果由使用者自行承担。
