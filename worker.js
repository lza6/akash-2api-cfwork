/**
 * =================================================================================
 * 项目: akash-2api (Cloudflare Worker 单文件版)
 * 版本: 2.0.0 (代号: Session Injection - 最终修正版)
 * 作者: 首席AI执行官 (Principal AI Executive Officer)
 * 协议: 奇美拉协议 · 综合版 (Project Chimera: Synthesis Edition)
 * 日期: 2025-11-30
 * 
 * [v2.0.0 关键修正]
 * 1. [核心修复] 解决了 403 Unauthorized 问题。必须提供 Cookie (session_token)。
 * 2. [协议适配] 完美支持 Vercel AI SDK 的流式响应解析。
 * 3. [指纹伪装] 严格复刻浏览器指纹，配合 Cookie 通过 WAF。
 * =================================================================================
 */

// --- [第一部分: 核心配置 (Configuration-as-Code)] ---
const CONFIG = {
  // 项目元数据
  PROJECT_NAME: "akash-2api",
  PROJECT_VERSION: "2.0.0",

  // 安全配置 (建议在 Cloudflare 环境变量中设置 API_MASTER_KEY)
  API_MASTER_KEY: "1",

  // 上游服务配置
  UPSTREAM_ORIGIN: "https://chat.akash.network",
  UPSTREAM_API_URL: "https://chat.akash.network/api/chat",

  // --- [关键配置] 凭证 (必须设置) ---
  // 从你的 HAR 文件中提取的 Cookie。
  // 如果部署后失效，请在浏览器 F12 -> Network -> 刷新页面 -> 复制最新请求的 Cookie
  // 格式: "cf_clearance=...; session_token=...; cookie-consent=accepted"
  AKASH_COOKIE: "cf_clearance=GmLSNlNmwSwo2a7Zk7XPOx3L8cDOGEOnbXxO34SRSag-1764488372-1.2.1.1-LNkVukDPqtLDgJv8zhUrZ5DXMLnwKEnFXUKApgSw1lr7HnDdYcouE1HXJHJG0G1FMF_6P7NqP.7Iv14LTLeqxQg.zPmRg7R8XM6_Ff0pwM9aZTBNyA61eTRBYeIHw_ntLFCpW5pWA5UwKwyVGZhRg5FPtqqLhG38RFsxPWkBg.uWxue9Qmgd4q5fi3XeCOcv55v4mnPjOkmiH88RDbsKl33LkJp9k5Gr.CpLfm2FAA0; session_token=543d9ddd7f514c811ec49b134b0c97287e73b06cb700c3c4a13d5903775e3571; cookie-consent=accepted",

  // 伪装头 (必须与 Cookie 来源浏览器的指纹一致)
  HEADERS: {
    "Host": "chat.akash.network",
    "Origin": "https://chat.akash.network",
    "Referer": "https://chat.akash.network/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    "Content-Type": "application/json",
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "sec-ch-ua": '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "priority": "u=1, i"
  },

  // 模型列表
  MODELS: [
    "DeepSeek-V3.1"
  ],
  DEFAULT_MODEL: "DeepSeek-V3.1"
};

// --- [第二部分: Worker 入口与路由] ---
export default {
  async fetch(request, env, ctx) {
    // 环境变量覆盖
    const apiKey = env.API_MASTER_KEY || CONFIG.API_MASTER_KEY;
    const cookie = env.AKASH_COOKIE || CONFIG.AKASH_COOKIE;
    
    request.ctx = { apiKey, cookie };

    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return handleCorsPreflight();
    if (url.pathname === '/') return handleUI(request);
    if (url.pathname.startsWith('/v1/')) return handleApi(request);
    
    return createErrorResponse(`路径未找到: ${url.pathname}`, 404, 'not_found');
  }
};

// --- [第三部分: API 代理逻辑] ---

async function handleApi(request) {
  if (!verifyAuth(request)) {
    return createErrorResponse('需要 Bearer Token 认证。', 401, 'unauthorized');
  }

  const url = new URL(request.url);
  const requestId = `req-${crypto.randomUUID()}`;

  if (url.pathname === '/v1/models') {
    return handleModelsRequest();
  } else if (url.pathname === '/v1/chat/completions') {
    return handleChatCompletions(request, requestId);
  } else {
    return createErrorResponse(`不支持的 API 路径: ${url.pathname}`, 404, 'not_found');
  }
}

function verifyAuth(request) {
  const authHeader = request.headers.get('Authorization');
  const validKey = request.ctx.apiKey;
  if (validKey === "1") return true; 
  return authHeader && authHeader === `Bearer ${validKey}`;
}

function handleModelsRequest() {
  const modelsData = {
    object: 'list',
    data: CONFIG.MODELS.map(modelId => ({
      id: modelId,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'akash-network',
    })),
  };
  return new Response(JSON.stringify(modelsData), {
    headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

async function handleChatCompletions(request, requestId) {
  try {
    const body = await request.json();
    const model = body.model || CONFIG.DEFAULT_MODEL;
    const stream = body.stream !== false;

    // 1. 提取 System Prompt 和 Messages
    let systemPrompt = "";
    let messages = [];
    
    if (body.messages) {
      for (const msg of body.messages) {
        if (msg.role === 'system') {
          systemPrompt += msg.content + "\n";
        } else {
          messages.push({
            role: msg.role,
            content: msg.content,
            parts: [{ type: "text", text: msg.content }] // 严格匹配抓包结构
          });
        }
      }
    }
    
    if (!systemPrompt) systemPrompt = "You are a helpful assistant.";

    // 2. 构造 Akash Payload
    const akashPayload = {
      id: generateRandomId(16),
      messages: messages,
      model: model,
      system: systemPrompt.trim(),
      temperature: String(body.temperature || "0.60"),
      topP: String(body.top_p || "0.95"),
      context: []
    };

    // 3. 准备请求头 (注入 Cookie)
    const headers = {
      ...CONFIG.HEADERS,
      "Cookie": request.ctx.cookie // 关键：注入 Cookie
    };

    // 4. 发送请求
    const response = await fetch(CONFIG.UPSTREAM_API_URL + "/", {
      method: "POST",
      headers: headers,
      body: JSON.stringify(akashPayload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMsg = errorText;
      try {
        const errJson = JSON.parse(errorText);
        if (errJson.message) errorMsg = errJson.message;
      } catch(e) {}
      
      // 如果是 403，明确提示 Cookie 问题
      if (response.status === 403) {
        errorMsg += " (请检查 AKASH_COOKIE 是否过期或正确填写)";
      }
      
      return createErrorResponse(`上游服务错误 (${response.status}): ${errorMsg}`, response.status, 'upstream_error');
    }

    // 5. 流式处理
    if (stream) {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      (async () => {
        try {
          const reader = response.body.getReader();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (!line.trim()) continue;
              
              // Vercel AI SDK 格式解析
              // 0:"text" -> 文本增量
              // e:{...} -> 结束/错误
              const match = line.match(/^(\w+):(.*)$/);
              if (match) {
                const type = match[1];
                let contentRaw = match[2];
                
                if (type === '0') {
                  try {
                    const content = JSON.parse(contentRaw);
                    const chunk = createChatCompletionChunk(requestId, model, content);
                    await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                  } catch (e) {}
                } else if (type === 'e') {
                  // 结束信号
                  const endChunk = createChatCompletionChunk(requestId, model, "", "stop");
                  await writer.write(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
                }
              }
            }
          }
          await writer.write(encoder.encode('data: [DONE]\n\n'));
        } catch (e) {
          const errChunk = createChatCompletionChunk(requestId, model, `\n\n[Error: ${e.message}]`, "stop");
          await writer.write(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
        } finally {
          await writer.close();
        }
      })();

      return new Response(readable, {
        headers: corsHeaders({ 'Content-Type': 'text/event-stream' })
      });

    } else {
      return createErrorResponse("请使用 stream=true 模式。", 400, 'invalid_request');
    }

  } catch (e) {
    return createErrorResponse(e.message, 500, 'internal_error');
  }
}

// --- 辅助函数 ---

function generateRandomId(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}

function createChatCompletionChunk(id, model, content, finishReason = null) {
  return {
    id: id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{ index: 0, delta: content ? { content: content } : {}, finish_reason: finishReason }]
  };
}

function createErrorResponse(message, status, code) {
  return new Response(JSON.stringify({
    error: { message, type: 'api_error', code }
  }), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' })
  });
}

function handleCorsPreflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// --- [第四部分: 开发者驾驶舱 UI (WebUI)] ---
function handleUI(request) {
  const origin = new URL(request.url).origin;
  const apiKey = request.ctx.apiKey;
  const cookieStatus = request.ctx.cookie ? "✅ 已配置" : "❌ 未配置 (请在代码 CONFIG 中填写)";
  
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${CONFIG.PROJECT_NAME} - 开发者驾驶舱</title>
    <style>
      :root { --bg: #121212; --panel: #1E1E1E; --border: #333; --text: #E0E0E0; --primary: #FFBF00; --success: #66BB6A; --error: #CF6679; }
      body { font-family: 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); margin: 0; height: 100vh; display: flex; overflow: hidden; }
      .sidebar { width: 380px; background: var(--panel); border-right: 1px solid var(--border); padding: 20px; display: flex; flex-direction: column; overflow-y: auto; flex-shrink: 0; }
      .main { flex: 1; display: flex; flex-direction: column; padding: 20px; position: relative; }
      .box { background: #252525; padding: 15px; border-radius: 8px; border: 1px solid var(--border); margin-bottom: 20px; }
      .label { font-size: 12px; color: #888; margin-bottom: 8px; display: block; font-weight: 600; }
      .code-block { font-family: monospace; font-size: 12px; color: var(--primary); word-break: break-all; background: #111; padding: 10px; border-radius: 4px; cursor: pointer; }
      input, select, textarea { width: 100%; background: #333; border: 1px solid #444; color: #fff; padding: 10px; border-radius: 4px; margin-bottom: 15px; box-sizing: border-box; }
      button { width: 100%; padding: 12px; background: var(--primary); border: none; border-radius: 4px; font-weight: bold; cursor: pointer; color: #000; }
      button:disabled { background: #555; cursor: not-allowed; }
      .chat-window { flex: 1; background: #000; border: 1px solid var(--border); border-radius: 8px; padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 20px; }
      .msg { max-width: 85%; padding: 15px; border-radius: 8px; line-height: 1.6; word-wrap: break-word; }
      .msg.user { align-self: flex-end; background: #333; color: #fff; }
      .msg.ai { align-self: flex-start; background: #1a1a1a; border: 1px solid #333; }
      .msg.error { color: var(--error); border-color: var(--error); }
      .debug-panel { margin-top: 20px; border-top: 1px solid var(--border); padding-top: 20px; }
      .log-entry { font-family: monospace; font-size: 11px; border-bottom: 1px solid #333; padding: 5px 0; color: #aaa; }
      .log-entry.err { color: var(--error); }
    </style>
</head>
<body>
    <div class="sidebar">
        <h2 style="margin-top:0; display:flex; align-items:center; gap:10px;">
            ⚡ ${CONFIG.PROJECT_NAME} 
            <span style="font-size:12px;color:#888; font-weight:normal; margin-top:4px;">v${CONFIG.PROJECT_VERSION}</span>
        </h2>
        
        <div class="box">
            <span class="label">Cookie 状态</span>
            <div style="color: ${request.ctx.cookie ? 'var(--success)' : 'var(--error)'}; font-weight:bold;">${cookieStatus}</div>
        </div>

        <div class="box">
            <span class="label">API 密钥 (点击复制)</span>
            <div class="code-block" onclick="copy('${apiKey}')">${apiKey}</div>
        </div>

        <div class="box">
            <span class="label">API 接口地址</span>
            <div class="code-block" onclick="copy('${origin}/v1/chat/completions')">${origin}/v1/chat/completions</div>
        </div>

        <div class="box">
            <span class="label">模型选择</span>
            <select id="model">
                ${CONFIG.MODELS.map(m => `<option value="${m}">${m}</option>`).join('')}
            </select>
            
            <span class="label">提示词 (Prompt)</span>
            <textarea id="prompt" rows="5" placeholder="输入你的问题...">你好，请介绍一下你自己。</textarea>
            
            <button id="btn-gen" onclick="sendRequest()">🚀 发送请求</button>
        </div>
        
        <div class="debug-panel">
            <span class="label">实时调试日志</span>
            <div id="debug-log" style="height: 150px; overflow-y: auto; background: #000; padding: 10px; border-radius: 4px;"></div>
        </div>
    </div>

    <main class="main">
        <div class="chat-window" id="chat">
            <div style="color:#666; text-align:center; margin-top:100px;">
                <div style="font-size:40px; margin-bottom:20px;">☁️</div>
                <h3>Akash Network 代理服务就绪</h3>
                <p>支持 DeepSeek-V3.1 等高性能模型。<br>请确保已在代码中配置有效的 Cookie。</p>
            </div>
        </div>
    </main>

    <script>
        const API_KEY = "${apiKey}";
        const ENDPOINT = "${origin}/v1/chat/completions";
        
        function copy(text) {
            navigator.clipboard.writeText(text);
            alert('已复制');
        }

        function log(type, msg) {
            const el = document.getElementById('debug-log');
            const div = document.createElement('div');
            div.className = \`log-entry \${type}\`;
            div.innerText = \`[\${new Date().toLocaleTimeString()}] \${msg}\`;
            el.appendChild(div);
            el.scrollTop = el.scrollHeight;
        }

        function appendMsg(role, text) {
            const div = document.createElement('div');
            div.className = \`msg \${role}\`;
            div.innerText = text;
            document.getElementById('chat').appendChild(div);
            div.scrollIntoView({ behavior: "smooth" });
            return div;
        }

        async function sendRequest() {
            const prompt = document.getElementById('prompt').value.trim();
            if (!prompt) return;

            const btn = document.getElementById('btn-gen');
            btn.disabled = true;
            btn.innerText = '⏳ 处理中...';

            if(document.querySelector('.chat-window').innerText.includes('代理服务就绪')) {
                document.getElementById('chat').innerHTML = '';
            }

            appendMsg('user', prompt);
            const aiMsg = appendMsg('ai', '');
            aiMsg.innerText = "▋";

            log('req', \`发送请求: \${prompt.substring(0, 20)}...\`);

            try {
                const res = await fetch(ENDPOINT, {
                    method: 'POST',
                    headers: { 
                        'Authorization': 'Bearer ' + API_KEY, 
                        'Content-Type': 'application/json' 
                    },
                    body: JSON.stringify({
                        model: document.getElementById('model').value,
                        messages: [{ role: 'user', content: prompt }],
                        stream: true
                    })
                });

                if (!res.ok) {
                    const errText = await res.text();
                    throw new Error(\`HTTP \${res.status}: \${errText}\`);
                }

                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let fullText = "";
                aiMsg.innerText = "";

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    const chunk = decoder.decode(value, { stream: true });
                    const lines = chunk.split('\\n');
                    
                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const dataStr = line.slice(6);
                            if (dataStr === '[DONE]') continue;
                            try {
                                const data = JSON.parse(dataStr);
                                const content = data.choices[0]?.delta?.content || "";
                                fullText += content;
                                aiMsg.innerText = fullText;
                            } catch (e) {}
                        }
                    }
                }
                log('res', '响应接收完成');

            } catch (e) {
                aiMsg.classList.add('error');
                aiMsg.innerText += \`\n[错误: \${e.message}]\`;
                log('err', e.message);
            } finally {
                btn.disabled = false;
                btn.innerText = '🚀 发送请求';
            }
        }
    </script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
