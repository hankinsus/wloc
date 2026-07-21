/* wloc.js - Complete Final Build 2026-07-22 */
(function () {
  "use strict";

  // 1. 简易环境检测
  const isSurge = typeof $environment !== "undefined" && Boolean($environment?.["surge-version"]);
  const isStash = typeof $environment !== "undefined" && Boolean($environment?.["stash-version"]);
  const isQuanX = typeof $task !== "undefined";
  const isLoon = typeof $loon !== "undefined";
  const isRocket = typeof $rocket !== "undefined" || (typeof $environment !== "undefined" && $environment?.product === "Shadowrocket");

  // 2. 轻量级持久化读取 (直接对接 wloc_settings)
  const Store = {
    getItem(key) {
      try {
        let val = null;
        if (isQuanX) val = $prefs.valueForKey(key);
        else if (isSurge || isStash || isLoon || isRocket || typeof $persistentStore !== "undefined") {
          val = $persistentStore.read(key);
        }
        return val ? JSON.parse(val) : null;
      } catch (e) {
        return null;
      }
    }
  };

  // 3. 基础字节处理
  function bytesFromArray(arr) { return new Uint8Array(arr); }
  function concatBytes(parts) {
    let total = 0;
    for (let i = 0; i < parts.length; i++) total += parts[i].length;
    let out = new Uint8Array(total);
    let offset = 0;
    for (let i = 0; i < parts.length; i++) {
      out.set(parts[i], offset);
      offset += parts[i].length;
    }
    return out;
  }
  function bodyToBytes(body) {
    if (body == null) return null;
    if (body instanceof Uint8Array) return body;
    if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) return new Uint8Array(body);
    if (typeof body === "string") {
      let out = new Uint8Array(body.length);
      for (let i = 0; i < body.length; i++) out[i] = body.charCodeAt(i) & 0xff;
      return out;
    }
    if (typeof body === "object" && typeof body.length === "number") return new Uint8Array(body);
    return null;
  }

  // 4. Protobuf 编码与解码核心
  function encodeVarint(val) {
    let v = BigInt(Math.trunc(val));
    if (v < 0n) v = BigInt.asUintN(64, v);
    let out = [];
    while (v >= 0x80n) {
      out.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    out.push(Number(v));
    return bytesFromArray(out);
  }
  function makeVarintField(fieldNo, val) {
    return concatBytes([encodeVarint((BigInt(fieldNo) << 3n) | 0n), encodeVarint(val)]);
  }
  function makeLengthDelimitedField(fieldNo, payload) {
    return concatBytes([encodeVarint((BigInt(fieldNo) << 3n) | 2n), encodeVarint(payload.length), payload]);
  }

  function decodeVarint(bytes, offset) {
    let result = 0n, shift = 0n, current = offset;
    while (current < bytes.length) {
      let b = bytes[current++];
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return { value: result, offset: current };
      shift += 7n;
    }
    throw new Error("unterminated varint");
  }

  function parseFields(bytes) {
    let fields = [], offset = 0;
    while (offset < bytes.length) {
      let keyStart = offset;
      let key = decodeVarint(bytes, offset);
      offset = key.offset;
      let fieldNumber = Number(key.value >> 3n);
      let wireType = Number(key.value & 0x7n);
      let valueStart = offset, valueEnd = offset;
      if (wireType === 0) valueEnd = decodeVarint(bytes, offset).offset;
      else if (wireType === 1) valueEnd = offset + 8;
      else if (wireType === 2) {
        let lenInfo = decodeVarint(bytes, offset);
        valueStart = lenInfo.offset;
        valueEnd = valueStart + Number(lenInfo.value);
      } else if (wireType === 5) valueEnd = offset + 4;
      else break;

      fields.push({
        fieldNumber, wireType,
        raw: bytes.slice(keyStart, valueEnd),
        valueBytes: bytes.slice(valueStart, valueEnd)
      });
      offset = valueEnd;
    }
    return fields;
  }

  // 5. 核心改位逻辑 (支持 WiFi & Cell 基站)
  const LOCATION_REPLACED = { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true, 11: true, 12: true };
  const CELL_FIELDS = { 22: true, 24: true };

  function patchLocation(locBytes, cfg) {
    let fields = locBytes.length ? parseFields(locBytes) : [];
    let parts = [];
    for (let i = 0; i < fields.length; i++) {
      if (!LOCATION_REPLACED[fields[i].fieldNumber]) parts.push(fields[i].raw);
    }
    let cLat = Math.trunc(cfg.latitude * 1e8);
    let cLon = Math.trunc(cfg.longitude * 1e8);
    let cAcc = Math.trunc(cfg.accuracy || 25);

    parts.push(makeVarintField(1, cLat));
    parts.push(makeVarintField(2, cLon));
    parts.push(makeVarintField(3, cAcc));
    parts.push(makeVarintField(4, 3));
    parts.push(makeVarintField(5, 530));
    parts.push(makeVarintField(6, 1000));
    parts.push(makeVarintField(11, 63));
    parts.push(makeVarintField(12, 467));
    return concatBytes(parts);
  }

  function patchWifi(wifiBytes, cfg) {
    let fields = parseFields(wifiBytes);
    let parts = [], patched = false;
    for (let i = 0; i < fields.length; i++) {
      if (fields[i].fieldNumber === 2 && fields[i].wireType === 2) {
        parts.push(makeLengthDelimitedField(2, patchLocation(fields[i].valueBytes, cfg)));
        patched = true;
      } else {
        parts.push(fields[i].raw);
      }
    }
    if (!patched) parts.push(makeLengthDelimitedField(2, patchLocation(bytesFromArray([]), cfg)));
    return concatBytes(parts);
  }

  function patchCell(cellBytes, cfg) {
    let fields = parseFields(cellBytes);
    let parts = [], patched = false;
    for (let i = 0; i < fields.length; i++) {
      if (fields[i].fieldNumber === 5 && fields[i].wireType === 2) {
        parts.push(makeLengthDelimitedField(5, patchLocation(fields[i].valueBytes, cfg)));
        patched = true;
      } else {
        parts.push(fields[i].raw);
      }
    }
    if (!patched) parts.push(makeLengthDelimitedField(5, patchLocation(bytesFromArray([]), cfg)));
    return concatBytes(parts);
  }

  function patchPayload(payload, cfg) {
    let fields = parseFields(payload);
    let parts = [], wifiCount = 0, cellCount = 0;
    for (let i = 0; i < fields.length; i++) {
      let f = fields[i];
      if (f.fieldNumber === 2 && f.wireType === 2) {
        parts.push(makeLengthDelimitedField(2, patchWifi(f.valueBytes, cfg)));
        wifiCount++;
      } else if (CELL_FIELDS[f.fieldNumber] && f.wireType === 2) {
        parts.push(makeLengthDelimitedField(f.fieldNumber, patchCell(f.valueBytes, cfg)));
        cellCount++;
      } else if (f.fieldNumber !== 3 && f.fieldNumber !== 4 && f.fieldNumber !== 33) {
        parts.push(f.raw);
      }
    }
    return { payload: concatBytes(parts), wifiCount, cellCount };
  }

  function processResponse(respBytes, cfg) {
    let payload = respBytes;
    let prefix = null;
    
    if (respBytes.length > 10 && respBytes[0] === 0x00 && respBytes[1] === 0x01) {
      let len = (respBytes[8] << 8) | respBytes[9];
      if (len > 0 && 10 + len <= respBytes.length) {
        prefix = respBytes.slice(0, 10);
        payload = respBytes.slice(10, 10 + len);
      }
    }

    let patched = patchPayload(payload, cfg);
    let finalBody = patched.payload;

    if (prefix) {
      let newLen = finalBody.length;
      prefix[8] = (newLen >> 8) & 0xff;
      prefix[9] = newLen & 0xff;
      finalBody = concatBytes([prefix, finalBody]);
    }

    return { body: finalBody, wifiCount: patched.wifiCount, cellCount: patched.cellCount };
  }

  // 6. 解析 $argument 辅助函数
  function parseArgumentString(argStr) {
    let result = {};
    if (!argStr || typeof argStr !== "string") return result;
    let pairs = argStr.split(/[&;]/);
    for (let i = 0; i < pairs.length; i++) {
      let part = pairs[i];
      if (!part) continue;
      let eq = part.indexOf("=");
      let k = eq >= 0 ? part.slice(0, eq) : part;
      let v = eq >= 0 ? part.slice(eq + 1) : "true";
      try { result[decodeURIComponent(k)] = decodeURIComponent(v); } catch (e) { result[k] = v; }
    }
    return result;
  }

  // 7. 主入口控制 (支持 网页端缓存优先 + 模块 argument 兜底)
  function run() {
    if (typeof $response === "undefined" || !$response) {
      $done({});
      return;
    }

    // 1. 优先读取网页端实时点选保存的值
    let settings = Store.getItem("wloc_settings");
    
    // 2. 如果本地存储没有，则回退读取模块 argument 里面的默认参数
    if (!settings || !settings.latitude || !settings.longitude) {
      if (typeof $argument !== "undefined" && $argument) {
        let args = parseArgumentString(typeof $argument === "string" ? $argument : JSON.stringify($argument));
        if (args.latitude && args.longitude) {
          settings = {
            latitude: parseFloat(args.latitude),
            longitude: parseFloat(args.longitude),
            accuracy: parseInt(args.accuracy || 25, 10)
          };
        }
      }
    }

    // 3. 如果两边都没有，则最终硬编码兜底为英国伦敦
    if (!settings || !settings.latitude || !settings.longitude) {
      settings = { latitude: 51.507900, longitude: -0.127800, accuracy: 25 };
    }

    let rawBody = $response.bodyBytes || bodyToBytes($response.body);
    if (!rawBody || rawBody.length < 2) {
      $done({});
      return;
    }

    try {
      let result = processResponse(rawBody, settings);
      let headers = $response.headers || {};
      
      delete headers["Content-Encoding"];
      delete headers["content-encoding"];
      delete headers["Transfer-Encoding"];
      delete headers["transfer-encoding"];
      headers["Content-Length"] = String(result.body.length);

      console.log(`[wloc] 🎯 成功劫持定位 -> 经度: ${settings.longitude}, 纬度: ${settings.latitude}`);

      if (isLoon) {
        $done({ status: 200, headers: headers, body: result.body });
      } else if (isQuanX) {
        $done({ status: "HTTP/1.1 200 OK", headers: headers, bodyBytes: result.body });
      } else {
        $done({ headers: headers, body: result.body });
      }
    } catch (e) {
      console.log("[wloc error]: " + e.message);
      $done({});
    }
  }

  run();
})();