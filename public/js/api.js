// 后端 API 封装
export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: opts.body !== undefined ? { "Content-Type": "application/json" } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && data.code !== "reauth") {
      location.reload();
    }
    throw new ApiError(data.error || `请求失败（${res.status}）`, res.status, data.code);
  }
  return data;
}

// 登录相关接口（/auth/*）：失败时不刷新页面，把错误交给调用方显示
export async function authApi(path, body = {}) {
  const res = await fetch("/auth" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `请求失败（${res.status}）`, res.status, data.code);
  return data;
}

// 带进度的附件上传（fetch 不支持上传进度，所以用 XHR）
export function uploadFile(file, onProgress) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise((resolve, reject) => {
    xhr.open("POST", "/api/uploads");
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name || "file"));
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(data.error || `上传失败（${xhr.status}）`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError("网络错误，上传失败", 0));
    xhr.onabort = () => reject(new ApiError("已取消", 0, "aborted"));
    xhr.send(file);
  });
  promise.abort = () => xhr.abort();
  return promise;
}
