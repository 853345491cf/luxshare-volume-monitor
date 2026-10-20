/*
 * 立讯精密 量比监控 —— 本地服务器
 * 零依赖，只用 Node 内置模块。Node 18+ 可直接运行：node serve.js
 *
 * 作用：
 *   1) 把 index.html 用 HTTP 提供出来，手机在同一 WiFi 下也能打开
 *   2) 代理腾讯行情接口，避免浏览器跨域 / GBK 编码问题
 */

"use strict";

var http = require("http");
var https = require("https");
var fs = require("fs");
var path = require("path");
var os = require("os");
var zlib = require("zlib");

var PORT = Number(process.env.PORT) || 8080;
var DEFAULT_SYMBOL = "sz002475";
var ROOT = __dirname;

/* 只接受 sh/sz/bj + 6 位数字，避免把任意路径拼进上游 URL */
function normSymbol(v){
  var s = String(v || "").trim().toLowerCase();
  return /^(sh|sz|bj)\d{6}$/.test(s) ? s : null;
}

/* ---------------- 抓取工具 ---------------- */

function request(url, opts){
  opts = opts || {};
  return new Promise(function(resolve, reject){
    var mod = url.indexOf("https:") === 0 ? https : http;
    var req = mod.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Referer": "https://gu.qq.com/",
        "Accept": "*/*",
        "Accept-Encoding": "gzip, deflate"
      }
    }, function(res){
      var chunks = [];
      res.on("data", function(c){ chunks.push(c); });
      res.on("end", function(){
        var buf = Buffer.concat(chunks);
        var enc = res.headers["content-encoding"];
        try {
          if (enc === "gzip") buf = zlib.gunzipSync(buf);
          else if (enc === "deflate") buf = zlib.inflateSync(buf);
        } catch (e) { /* 解压失败就按原始内容处理 */ }
        if (res.statusCode !== 200){
          reject(new Error("HTTP " + res.statusCode + " " + url));
          return;
        }
        resolve({ buf: buf, headers: res.headers });
      });
      res.on("error", reject);
    });
    req.setTimeout(8000, function(){ req.destroy(new Error("timeout")); });
    req.on("error", reject);
  });
}

function requestJson(url){
  return request(url).then(function(r){
    return JSON.parse(r.buf.toString("utf8"));
  });
}

/* 腾讯行情返回 GBK，需要转成 UTF-8 */
function requestGbk(url){
  return request(url).then(function(r){
    try {
      return new TextDecoder("gbk").decode(r.buf);
    } catch (e) {
      return r.buf.toString("latin1");
    }
  });
}

/* ---------------- 三个接口 ---------------- */

function apiQuote(sym){
  return requestGbk("https://qt.gtimg.cn/q=" + sym + "&_=" + Date.now()).then(function(text){
    var m = text.match(/="([^"]*)"/);
    if (!m) throw new Error("empty");
    var f = m[1].split("~");
    if (f.length < 50) throw new Error("format");
    var n = function(i){ var v = parseFloat(f[i]); return isFinite(v) ? v : null; };
    return {
      symbol: sym, name: f[1] || "",
      price:   n(3),  prev: n(4), open: n(5), high: n(33), low: n(34),
      volHand: n(6),  amtYuan: (n(37) || 0) * 10000,
      turnover: n(38), ratio: n(49), amp: n(43),
      chgPct:  n(32), chgAmt: n(31), time: f[30] || ""
    };
  });
}

function apiKline(sym, days){
  var d = Math.max(10, Math.min(640, days || 120));
  var url = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=" +
            sym + ",day,,," + d + ",qfq";
  return requestJson(url).then(function(res){
    var node = res && res.data && res.data[sym];
    var arr = node && (node.qfqday || node.day);
    if (!arr || !arr.length) throw new Error("empty");
    return arr.map(function(r){
      return {
        date:  r[0],
        open:  parseFloat(r[1]),
        close: parseFloat(r[2]),
        high:  parseFloat(r[3]),
        low:   parseFloat(r[4]),
        vol:   parseFloat(r[5])          // 手
      };
    });
  });
}

function apiMinute(sym){
  var url = "https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=" + sym;
  return requestJson(url).then(function(res){
    var d = res && res.data && res.data[sym] && res.data[sym].data;
    if (!d || !d.data || !d.data.length) throw new Error("empty");

    var points = [];
    var prevCum = 0;
    for (var i = 0; i < d.data.length; i++){
      var parts = String(d.data[i]).split(" ");
      if (parts.length < 3) continue;
      var t = parts[0];
      if (t > "1500") continue;            // 剔除盘后固定价格交易
      var price = parseFloat(parts[1]);
      var cum   = parseFloat(parts[2]);
      var amt   = parseFloat(parts[3]);
      if (!isFinite(price) || !isFinite(cum)) continue;
      var vol = cum - prevCum;
      if (vol < 0) vol = 0;
      prevCum = cum;
      points.push({ t: t, price: price, vol: vol, cum: cum, amt: amt });
    }
    return { date: d.date, points: points };
  });
}

/* 代码 / 名称搜索：腾讯 smartbox，返回 v_hint="sz~002475~立讯精密~lxjm~GP-A~..." */
function apiSearch(q){
  var url = "https://smartbox.gtimg.cn/s3/?t=all&q=" + encodeURIComponent(q) + "&_=" + Date.now();
  return requestGbk(url).then(function(text){
    var m = String(text).match(/="([^"]*)"/);
    var body = m ? m[1] : "";
    if (!body) return [];
    body = body.replace(/\\u([0-9a-fA-F]{4})/g, function(_, h){   // 中文被转义成 \uXXXX
      return String.fromCharCode(parseInt(h, 16));
    });
    var out = [];
    body.split("^").forEach(function(item){
      var f = item.split("~");
      if (f.length < 3) return;
      var mk = f[0], code = f[1], name = f[2], type = f[4] || "";
      if (!/^(sh|sz|bj)$/.test(mk) || !/^\d{6}$/.test(code)) return;
      if (type && !/^(GP|ZS|JJ)/.test(type)) return;   // 只留股票 / 指数 / 基金
      out.push({ symbol: mk + code, code: code, name: name, type: type });
    });
    return out;
  });
}

/* 上游偶尔返回空，重试一次 */
function retry(fn, times){
  return fn().catch(function(err){
    if (times <= 1) throw err;
    return new Promise(function(r){ setTimeout(r, 300); }).then(function(){
      return retry(fn, times - 1);
    });
  });
}

/* ---------------- 静态文件 ---------------- */

var MIME = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".ico":  "image/x-icon"
};

function sendJson(res, code, obj){
  var body = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(body);
}

function sendFile(res, file){
  fs.readFile(file, function(err, buf){
    if (err){
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 Not Found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Content-Length": buf.length,
      "Cache-Control": "no-cache"
    });
    res.end(buf);
  });
}

/* ---------------- 服务器 ---------------- */

var server = http.createServer(function(req, res){
  var u;
  try { u = new URL(req.url, "http://localhost"); }
  catch (e) { return sendJson(res, 400, { error: "bad url" }); }

  var p = u.pathname;

  function fail(err){
    console.error("[api]", p, err && err.message);
    sendJson(res, 502, { error: String(err && err.message || err) });
  }

  var rawSym = u.searchParams.get("symbol");
  var sym = rawSym ? normSymbol(rawSym) : DEFAULT_SYMBOL;

  if (p === "/api/search"){
    var q = (u.searchParams.get("q") || "").trim().slice(0, 32);
    if (!q) return sendJson(res, 200, []);
    retry(function(){ return apiSearch(q); }, 2)
      .then(function(o){ sendJson(res, 200, o); }).catch(fail);
    return;
  }

  if (p === "/api/quote" || p === "/api/kline" || p === "/api/minute"){
    if (rawSym && !normSymbol(rawSym)) return sendJson(res, 400, { error: "bad symbol" });
  }

  if (p === "/api/quote"){
    retry(function(){ return apiQuote(sym); }, 2)
      .then(function(o){ sendJson(res, 200, o); }).catch(fail);
    return;
  }
  if (p === "/api/kline"){
    var days = parseInt(u.searchParams.get("days"), 10);
    var d = isFinite(days) ? days : 120;
    retry(function(){ return apiKline(sym, d); }, 2)
      .then(function(o){ sendJson(res, 200, o); }).catch(fail);
    return;
  }
  if (p === "/api/minute"){
    retry(function(){ return apiMinute(sym); }, 2)
      .then(function(o){ sendJson(res, 200, o); }).catch(fail);
    return;
  }

  // 静态资源：只允许 ROOT 目录内
  var rel = decodeURIComponent(p === "/" ? "/index.html" : p);
  var file = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[\/\\])+/, ""));
  if (file.indexOf(ROOT) !== 0){
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("403 Forbidden");
    return;
  }
  sendFile(res, file);
});

function lanAddresses(){
  var out = [];
  var ifs = os.networkInterfaces();
  Object.keys(ifs).forEach(function(name){
    (ifs[name] || []).forEach(function(it){
      if (it.family !== "IPv4" || it.internal) return;
      if (/^169\.254\./.test(it.address)) return;      // 自动私有地址，无法访问
      out.push(it.address);
    });
  });
  // 家用 / 办公局域网网段排前面
  out.sort(function(a, b){
    var rank = function(ip){
      if (/^192\.168\./.test(ip)) return 0;
      if (/^10\./.test(ip)) return 1;
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
      return 3;
    };
    return rank(a) - rank(b);
  });
  return out;
}

server.on("error", function(err){
  if (err.code === "EADDRINUSE"){
    console.error("端口 " + PORT + " 已被占用。可换端口重启：");
    console.error("  set PORT=8090 && node serve.js");
  } else {
    console.error(err.message);
  }
  process.exit(1);
});

server.listen(PORT, "0.0.0.0", function(){
  console.log("");
  console.log("  立讯精密 量比监控 已启动");
  console.log("  ------------------------------------------");
  console.log("  本机：  http://localhost:" + PORT);
  var lan = lanAddresses();
  lan.forEach(function(ip, i){
    console.log((i === 0 ? "  手机：  " : "          ") + "http://" + ip + ":" + PORT);
  });
  if (!lan.length) console.log("  手机：  未检测到局域网地址，请确认已连 WiFi");
  console.log("  ------------------------------------------");
  console.log("  按 Ctrl+C 停止");
  console.log("");
});
