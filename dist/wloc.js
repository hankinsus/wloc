/* wloc.js - Enhanced Build 2026-07-22
 * 目标：更高修改成功率
 * - 完整替换 Location 字段（经纬度/水平精度/海拔/垂直精度/运动类型）
 * - 纯沙盒读取 wloc_settings（无坐标则透传）
 * - 多策略 payload 提取
 * - 保留 Gzip 兼容处理
 */
(function () {
  "use strict";

  // ==================== 环境检测 ====================
  var isQuanX = typeof $task !== "undefined";
  var isLoon = typeof $loon !== "undefined";
  var isSurge = typeof $environment !== "undefined" && Boolean($environment && $environment["surge-version"]);
  var isStash = typeof $environment !== "undefined" && Boolean($environment && $environment["stash-version"]);
  var isRocket = typeof $rocket !== "undefined" || (typeof $environment !== "undefined" && $environment && $environment.product === "Shadowrocket");

  // ==================== 默认配置 ====================
  var DEFAULT = {
    longitude: null,
    latitude: null,
    accuracy: 25,          // horizontalAccuracy
    altitude: 30,          // 海拔（米）
    verticalAccuracy: 10,  // 垂直精度
    unknownValue4: 3,
    motionActivityType: 63,
    motionActivityConfidence: 467,
    logLevel: "info"
  };

  // ==================== 工具函数 ====================
  function bytesFromArray(arr) {
    return new Uint8Array(arr);
  }

  function concatBytes(parts) {
    var total = 0, i;
    for (i = 0; i < parts.length; i++) total += parts[i].length;
    var out = new Uint8Array(total);
    var offset = 0;
    for (i = 0; i < parts.length; i++) {
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
      var out = new Uint8Array(body.length);
      for (var i = 0; i < body.length; i++) out[i] = body.charCodeAt(i) & 0xff;
      return out;
    }
    if (typeof body === "object" && typeof body.length === "number") return new Uint8Array(body);
    return null;
  }

  function messageBodyToBytes(msg) {
    if (!msg) return null;
    return bodyToBytes(msg.bodyBytes) || bodyToBytes(msg.body) || bodyToBytes(msg.rawBody) || bodyToBytes(msg.binaryBody);
  }

  function isGzip(bytes) {
    return bytes && bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  }

  // 简易 ungzip（优先用运行时工具，失败则原样返回）
  function tryUngzip(bytes) {
    if (!isGzip(bytes)) return bytes;
    try {
      if (typeof $utils !== "undefined" && $utils.ungzip) {
        var decoded = $utils.ungzip(bytes);
        if (decoded) return bodyToBytes(decoded) || bytes;
      }
    } catch (e) {}
    return bytes;
  }

  // ==================== Protobuf 基础 ====================
  function encodeVarint(value) {
    var v = Math.floor(value);
    if (v < 0) {
      // 处理负数（用于坐标）
      v = v >>> 0; // 转无符号再处理会有问题，改用 BigInt 风格简化
    }
    var out = [];
    while (v >= 0x80) {
      out.push((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(v);
    return bytesFromArray(out);
  }

  function encodeSignedVarint(value) {
    // 简化：直接按 int64 处理常见坐标范围
    var v = Math.trunc(value);
    var out = [];
    // 对负数使用 ZigZag 或直接按无符号补码（苹果坐标用的是普通 signed varint）
    if (v < 0) {
      // 简化实现：转成无符号 64 位补码风格（足够覆盖坐标）
      v = v + 0x10000000000000000; // 实际用 BigInt 更准确，这里用近似
    }
    while (v >= 0x80) {
      out.push((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(v & 0x7f);
    return bytesFromArray(out);
  }

  // 更稳妥的 signed varint（兼容负坐标）
  function encodeVarint64(value) {
    var v = BigInt(Math.trunc(value));
    if (v < 0n) {
      v = BigInt.asUintN(64, v);
    }
    var out = [];
    while (v >= 0x80n) {
      out.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    out.push(Number(v));
    return bytesFromArray(out);
  }

  function makeKey(fieldNo, wireType) {
    return encodeVarint64((BigInt(fieldNo) << 3n) | BigInt(wireType));
  }

  function makeVarintField(fieldNo, value) {
    return concatBytes([makeKey(fieldNo, 0), encodeVarint64(value)]);
  }

  function makeLengthField(fieldNo, payload) {
    return concatBytes([makeKey(fieldNo, 2), encodeVarint64(payload.length), payload]);
  }

  function decodeVarint(bytes, offset) {
    var result = 0n;
    var shift = 0n;
    var pos = offset;
    while (pos < bytes.length) {
      var b = bytes[pos++];
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) {
        return { value: result, offset: pos };
      }
      shift += 7n;
      if (shift > 70n) throw new Error("varint too long");
    }
    throw new Error("unterminated varint");
  }

  function parseFields(bytes) {
    var fields = [];
    var offset = 0;
    while (offset < bytes.length) {
      var keyStart = offset;
      var key = decodeVarint(bytes, offset);
      offset = key.offset;
      var fieldNo = Number(key.value >> 3n);
      var wireType = Number(key.value & 0x7n);
      if (fieldNo === 0) throw new Error("invalid field 0");

      var valueStart = offset;
      var valueEnd;
      if (wireType === 0) {
        valueEnd = decodeVarint(bytes, offset).offset;
      } else if (wireType === 1) {
        valueEnd = offset + 8;
      } else if (wireType === 2) {
        var lenInfo = decodeVarint(bytes, offset);
        valueStart = lenInfo.offset;
        valueEnd = valueStart + Number(lenInfo.value);
      } else if (wireType === 5) {
        valueEnd = offset + 4;
      } else {
        throw new Error("unsupported wire type " + wireType);
      }
      if (valueEnd > bytes.length) throw new Error("field exceeds buffer");
      fields.push({
        fieldNo: fieldNo,
        wireType: wireType,
        raw: bytes.slice(keyStart, valueEnd),
        valueBytes: bytes.slice(valueStart, valueEnd)
      });
      offset = valueEnd;
    }
    return fields;
  }

  // ==================== Location 完整替换（关键增强） ====================
  function patchLocation(locationPayload, cfg) {
    // 保留非 Location 核心字段，强制覆盖下面这些
    var parts = [];
    try {
      var fields = locationPayload && locationPayload.length ? parseFields(locationPayload) : [];
      for (var i = 0; i < fields.length; i++) {
        var f = fields[i];
        // 跳过我们要强制重写的字段
        if (f.fieldNo === 1 || f.fieldNo === 2 || f.fieldNo === 3 || f.fieldNo === 4 ||
            f.fieldNo === 5 || f.fieldNo === 6 || f.fieldNo === 11 || f.fieldNo === 12) {
          continue;
        }
        parts.push(f.raw);
      }
    } catch (e) {}

    // 强制写入完整字段
    parts.push(makeVarintField(1, Math.trunc(cfg.latitude * 1e8)));   // lat
    parts.push(makeVarintField(2, Math.trunc(cfg.longitude * 1e8)));  // lon
    parts.push(makeVarintField(3, cfg.accuracy));                    // horizontalAccuracy
    parts.push(makeVarintField(4, cfg.unknownValue4));               // unknown
    parts.push(makeVarintField(5, cfg.altitude));                    // altitude
    parts.push(makeVarintField(6, cfg.verticalAccuracy));            // verticalAccuracy
    parts.push(makeVarintField(11, cfg.motionActivityType));         // motion type
    parts.push(makeVarintField(12, cfg.motionActivityConfidence));   // motion confidence
    return concatBytes(parts);
  }

  function patchWifi(wifiPayload, cfg) {
    var fields = parseFields(wifiPayload);
    var parts = [];
    var patched = false;
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f.fieldNo === 2 && f.wireType === 2) {
        parts.push(makeLengthField(2, patchLocation(f.valueBytes, cfg)));
        patched = true;
      } else {
        parts.push(f.raw);
      }
    }
    if (!patched) {
      parts.push(makeLengthField(2, patchLocation(new Uint8Array(0), cfg)));
    }
    return concatBytes(parts);
  }

  function patchCell(cellPayload, cfg) {
    var fields = parseFields(cellPayload);
    var parts = [];
    var patched = false;
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f.fieldNo === 5 && f.wireType === 2) {
        parts.push(makeLengthField(5, patchLocation(f.valueBytes, cfg)));
        patched = true;
      } else {
        parts.push(f.raw);
      }
    }
    if (!patched) {
      parts.push(makeLengthField(5, patchLocation(new Uint8Array(0), cfg)));
    }
    return concatBytes(parts);
  }

  function patchPayload(payload, cfg) {
    var fields = parseFields(payload);
    var parts = [];
    var wifiCount = 0, cellCount = 0;
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f.fieldNo === 2 && f.wireType === 2) {
        parts.push(makeLengthField(2, patchWifi(f.valueBytes, cfg)));
        wifiCount++;
      } else if ((f.fieldNo === 22 || f.fieldNo === 24) && f.wireType === 2) {
        parts.push(makeLengthField(f.fieldNo, patchCell(f.valueBytes, cfg)));
        cellCount++;
      } else if (f.fieldNo !== 3 && f.fieldNo !== 4 && f.fieldNo !== 33) {
        parts.push(f.raw);
      }
    }
    return { data: concatBytes(parts), wifiCount: wifiCount, cellCount: cellCount };
  }

  // ==================== 帧提取与修改 ====================
  function tryExtractAndPatch(bytes, cfg) {
    // 策略1：常见 0x00 0x01 前缀 + 长度
    if (bytes.length >= 10 && bytes[0] === 0x00 && bytes[1] === 0x01) {
      var len = (bytes[8] << 8) | bytes[9];
      if (len > 0 && 10 + len <= bytes.length) {
        try {
          var payload = bytes.slice(10, 10 + len);
          var result = patchPayload(payload, cfg);
          if (result.wifiCount + result.cellCount > 0) {
            var newLen = result.data.length;
            var prefix = bytes.slice(0, 8);
            return {
              body: concatBytes([prefix, bytesFromArray([(newLen >> 8) & 0xff, newLen & 0xff]), result.data, bytes.slice(10 + len)]),
              wifiCount: result.wifiCount,
              cellCount: result.cellCount,
              method: "prefix"
            };
          }
        } catch (e) {}
      }
    }

    // 策略2：直接当 protobuf 扫
    try {
      var result2 = patchPayload(bytes, cfg);
      if (result2.wifiCount + result2.cellCount > 0) {
        return { body: result2.data, wifiCount: result2.wifiCount, cellCount: result2.cellCount, method: "raw" };
      }
    } catch (e) {}

    // 策略3：多偏移搜索
    var offsets = [0, 2, 4, 6, 8, 10, 12, 14, 16];
    for (var i = 0; i < Math.min(64, bytes.length - 10); i++) {
      if (offsets.indexOf(i) < 0) offsets.push(i);
    }
    for (var o = 0; o < offsets.length; o++) {
      var base = offsets[o];
      if (base + 10 > bytes.length) continue;
      try {
        var flen = (bytes[base + 8] << 8) | bytes[base + 9];
        if (flen <= 0 || base + 10 + flen > bytes.length) continue;
        var p = bytes.slice(base + 10, base + 10 + flen);
        var r = patchPayload(p, cfg);
        if (r.wifiCount + r.cellCount > 0) {
          var nl = r.data.length;
          return {
            body: concatBytes([
              bytes.slice(0, base + 8),
              bytesFromArray([(nl >> 8) & 0xff, nl & 0xff]),
              r.data,
              bytes.slice(base + 10 + flen)
            ]),
            wifiCount: r.wifiCount,
            cellCount: r.cellCount,
            method: "offset-" + base
          };
        }
      } catch (e) {}
    }

    return null;
  }

  // ==================== 沙盒读取（纯沙盒） ====================
  function loadSettings() {
    var raw = null;
    try {
      if (isQuanX) {
        raw = $prefs.valueForKey("wloc_settings");
      } else if (typeof $persistentStore !== "undefined") {
        raw = $persistentStore.read("wloc_settings");
      }
    } catch (e) {}

    if (!raw) {
      try {
        if (typeof $prefs !== "undefined" && $prefs.valueForKey) {
          raw = $prefs.valueForKey("wloc_settings");
        } else if (typeof $persistentStore !== "undefined" && $persistentStore.read) {
          raw = $persistentStore.read("wloc_settings");
        }
      } catch (e) {}
    }

    var cfg = Object.assign({}, DEFAULT);
    if (!raw) {
      console.log("[wloc] 沙盒为空，透传真实定位");
      return cfg;
    }

    try {
      var s = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (s && s.longitude != null && s.latitude != null) {
        var lon = parseFloat(s.longitude);
        var lat = parseFloat(s.latitude);
        if (isFinite(lon) && isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
          cfg.longitude = lon;
          cfg.latitude = lat;
          if (s.accuracy != null) cfg.accuracy = parseInt(s.accuracy, 10) || 25;
          if (s.altitude != null) cfg.altitude = parseInt(s.altitude, 10) || 30;
          console.log("[wloc] 命中沙盒坐标: " + lon + "," + lat + " acc=" + cfg.accuracy);
          return cfg;
        }
      }
    } catch (e) {}

    console.log("[wloc] 沙盒数据无效，透传真实定位");
    return cfg;
  }

  // ==================== 主流程 ====================
  function run() {
    if (typeof $response === "undefined" || !$response) {
      $done({});
      return;
    }

    var cfg = loadSettings();
    if (cfg.longitude == null || cfg.latitude == null) {
      $done({});
      return;
    }

    var rawBody = messageBodyToBytes($response);
    if (!rawBody || rawBody.length < 2) {
      $done({});
      return;
    }

    // 尝试解压
    var body = tryUngzip(rawBody);

    try {
      var patched = tryExtractAndPatch(body, cfg);
      if (!patched) {
        console.log("[wloc] no patchable payload, passthrough");
        $done({});
        return;
      }

      console.log("[wloc] patched method=" + patched.method + " wifi=" + patched.wifiCount + " cell=" + patched.cellCount);

      var headers = Object.assign({}, $response.headers || {});
      delete headers["Content-Encoding"];
      delete headers["content-encoding"];
      delete headers["Transfer-Encoding"];
      delete headers["transfer-encoding"];
      headers["Content-Length"] = String(patched.body.length);

      if (isLoon) {
        $done({ status: 200, headers: headers, body: patched.body });
      } else if (isQuanX) {
        $done({ status: "HTTP/1.1 200 OK", headers: headers, bodyBytes: patched.body });
      } else {
        $done({ headers: headers, body: patched.body });
      }
    } catch (e) {
      console.log("[wloc] error: " + (e.message || e));
      $done({});
    }
  }

  run();
})();