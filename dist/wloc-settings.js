/* wloc-settings.js - Optimized & Clean Build 2026-07-22 (Fixed) */
(function () {
  "use strict";

  // 1. 运行环境精准识别
  const isQuanX = typeof $task !== "undefined";
  const isSurge = typeof $environment !== "undefined" && Boolean($environment?.["surge-version"]);
  const isStash = typeof $environment !== "undefined" && Boolean($environment?.["stash-version"]);
  const isLoon = typeof $loon !== "undefined";
  const isRocket = typeof $rocket !== "undefined" || (typeof $environment !== "undefined" && $environment?.product === "Shadowrocket");

  const SETTINGS_KEY = "wloc_settings";

  // 2. 优雅的本地存储读写
  function readSettings() {
    try {
      let raw = null;
      if (isQuanX) raw = $prefs.valueForKey(SETTINGS_KEY);
      else if (isSurge || isStash || isLoon || isRocket || typeof $persistentStore !== "undefined") {
        raw = $persistentStore.read(SETTINGS_KEY);
      }
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function writeSettings(data) {
    try {
      // 清除时优先尝试真正删除
      if (data === null) {
        if (isQuanX && $prefs.removeValueForKey) {
          $prefs.removeValueForKey(SETTINGS_KEY);
          return true;
        }
        if (typeof $persistentStore !== "undefined" && $persistentStore.write) {
          // 多数工具 write(null, key) 等同于删除
          $persistentStore.write(null, SETTINGS_KEY);
          return true;
        }
      }

      let str = JSON.stringify(data);
      if (isQuanX) return $prefs.setValueForKey(str, SETTINGS_KEY);
      if (isSurge || isStash || isLoon || isRocket || typeof $persistentStore !== "undefined") {
        return $persistentStore.write(str, SETTINGS_KEY);
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  // 3. 清爽规范的 URL 参数解析
  function parseQuery(url) {
    let out = {};
    let qi = url.indexOf("?");
    if (qi < 0) return out;
    let parts = url.slice(qi + 1).split("&");
    for (let i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      let eq = parts[i].indexOf("=");
      let k = eq < 0 ? parts[i] : parts[i].slice(0, eq);
      let v = eq < 0 ? "" : parts[i].slice(eq + 1);
      try { k = decodeURIComponent(k.replace(/\+/g, " ")); } catch (e) {}
      try { v = decodeURIComponent(v.replace(/\+/g, " ")); } catch (e) {}
      if (!(k in out)) out[k] = v;
    }
    return out;
  }

  // 4. 数值有效性过滤
  function finiteNum(s) {
    if (s == null || s === "") return NaN;
    let n = parseFloat(s);
    return isFinite(n) ? n : NaN;
  }

  let requestUrl = (typeof $request !== "undefined" && $request && $request.url) || "";
  let q = parseQuery(requestUrl);
  let action = q.action || "save";
  let result = {};

  // 5. 核心逻辑分支
  if (action === "query") {
    let current = readSettings();
    if (current && current.longitude != null && current.latitude != null) {
      result = {
        success: true,
        longitude: current.longitude,
        latitude: current.latitude,
        accuracy: current.accuracy || 25,
        updatedAt: current.updatedAt || new Date().toISOString()
      };
      console.log(`[wloc-settings] 📌 当前生效坐标: [${current.longitude}, ${current.latitude}]`);
    } else {
      result = { success: false, error: "无已保存的坐标数据" };
      console.log("[wloc-settings] ⚠️ 当前暂无保存的定位数据");
    }
  } else if (action === "clear") {
    writeSettings(null);
    result = { success: true };
    console.log("[wloc-settings] 🗑️ 已成功清除所有保存的定位数据");
  } else {
    // save
    let lon = finiteNum(q.lon != null ? q.lon : q.longitude);
    let lat = finiteNum(q.lat != null ? q.lat : q.latitude);
    let acc = parseInt(q.acc || q.accuracy || "25", 10);
    if (!Number.isFinite(acc) || acc <= 0) acc = 25;

    if (isFinite(lon) && isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      // 加上东八区北京时间戳，方便排查
      let beijingTime = new Date(Date.now() + 288e5).toISOString().replace("Z", "+08:00");
      let dataToSave = {
        longitude: lon,
        latitude: lat,
        accuracy: acc,
        updatedAt: beijingTime
      };

      if (writeSettings(dataToSave)) {
        result = { success: true, longitude: lon, latitude: lat, accuracy: acc };
        console.log(`[wloc-settings] ✅ 成功写入新坐标: 经度 ${lon}, 纬度 ${lat}, 精度 ${acc}m`);
      } else {
        result = { success: false, error: "底层存储写入失败 (Storage Write Error)" };
        console.log("[wloc-settings] ❌ 坐标写入本地存储失败！");
      }
    } else {
      result = { success: false, error: "缺少经纬度参数或数值非法 (Missing/Invalid lon/lat)" };
      console.log("[wloc-settings] ❌ 请求参数错误：缺少有效的 lon 或 lat");
    }
  }

  // 6. 规范优雅的 HTTP 响应头
  let headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS"
  };
  let bodyStr = JSON.stringify(result);

  if (isQuanX) {
    $done({ status: "HTTP/1.1 200 OK", headers: headers, body: bodyStr });
  } else {
    $done({ response: { status: 200, headers: headers, body: bodyStr } });
  }
})();