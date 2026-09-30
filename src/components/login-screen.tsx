"use client";

import { ArrowRight, KeyRound, ShieldCheck } from "lucide-react";
import { FormEvent, useState } from "react";

export function LoginScreen() {
  const [accessKey, setAccessKey] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessKey }),
      });
      if (!response.ok) {
        throw new Error("连接口令不正确，请向管理员确认后重试");
      }
      window.location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法完成验证");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-mark" aria-hidden="true">
          <span>DF</span>
          <i />
        </div>
        <div className="login-copy">
          <p>DAILY CONTENT OPERATIONS</p>
          <h1 id="login-title">进入 DailyForge</h1>
          <span>管理内容计划、生成结果和运营设备。</span>
        </div>
        <form onSubmit={submit}>
          <label htmlFor="access-key">管理员连接口令</label>
          <div className="login-input">
            <KeyRound aria-hidden="true" />
            <input
              autoComplete="current-password"
              autoFocus
              id="access-key"
              maxLength={512}
              onChange={(event) => setAccessKey(event.target.value)}
              placeholder="输入管理员提供的口令"
              type="password"
              value={accessKey}
            />
          </div>
          {error ? <p className="login-error" role="alert">{error}</p> : null}
          <button disabled={pending || !accessKey.trim()} type="submit">
            {pending ? "正在验证" : "进入运行台"}
            <ArrowRight aria-hidden="true" />
          </button>
        </form>
        <footer>
          <ShieldCheck aria-hidden="true" />
          <span>密钥只用于本次登录，不会显示在页面中</span>
        </footer>
      </section>
    </main>
  );
}
