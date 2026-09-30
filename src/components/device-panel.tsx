"use client";

import {
  CheckCircle2,
  CircleOff,
  Copy,
  Laptop,
  LoaderCircle,
  MonitorUp,
  Plus,
  Radio,
} from "lucide-react";
import { useCallback, useEffect, useState, useTransition } from "react";
import type { OperatorDevice } from "@/lib/devices/types";

interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { message: string };
}

interface PairingResult {
  device: OperatorDevice;
  pairingCode: string;
  expiresAt: string;
}

function lastSeenLabel(value: string | null) {
  if (!value) return "尚未连接";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function DevicePanel() {
  const [devices, setDevices] = useState<OperatorDevice[]>([]);
  const [name, setName] = useState("");
  const [pairing, setPairing] = useState<PairingResult | null>(null);
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();

  const request = useCallback(async <T,>(path: string, init?: RequestInit) => {
    const response = await fetch(path, {
      ...init,
      cache: "no-store",
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
    const result = (await response.json()) as ApiEnvelope<T>;
    if (!response.ok || !result.ok || result.data === undefined) {
      throw new Error(result.error?.message || "设备操作未完成");
    }
    return result.data;
  }, []);

  const load = useCallback(async () => {
    setDevices(await request<OperatorDevice[]>("/api/admin/devices"));
  }, [request]);

  useEffect(() => {
    let cancelled = false;
    request<OperatorDevice[]>("/api/admin/devices")
      .then((result) => {
        if (!cancelled) setDevices(result);
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "无法读取设备");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [request]);

  function action(task: () => Promise<void>) {
    setError("");
    startTransition(async () => {
      try {
        await task();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "设备操作未完成");
      }
    });
  }

  return (
    <section className="device-panel" aria-labelledby="device-heading">
      <header className="device-heading">
        <div>
          <p>LOCAL DRAFT COMPANION</p>
          <h2 id="device-heading">运营电脑</h2>
          <span>只有标记为执行设备的电脑会领取社媒草稿任务。</span>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            action(async () => {
              const result = await request<PairingResult>("/api/admin/devices", {
                method: "POST",
                body: JSON.stringify({ name }),
              });
              setPairing(result);
              setName("");
              await load();
            });
          }}
        >
          <input
            aria-label="新电脑名称"
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：内容组电脑"
            value={name}
          />
          <button disabled={isPending || !name.trim()} type="submit">
            <Plus aria-hidden="true" />添加电脑
          </button>
        </form>
      </header>

      {pairing ? (
        <div className="pairing-ticket" role="status">
          <div>
            <span>一次性连接码</span>
            <strong>{pairing.pairingCode}</strong>
            <small>20 分钟内在新电脑的安装向导中输入</small>
          </div>
          <button
            type="button"
            onClick={() => navigator.clipboard.writeText(pairing.pairingCode)}
          >
            <Copy aria-hidden="true" />复制
          </button>
        </div>
      ) : null}

      {error ? <div className="device-error" role="alert">{error}</div> : null}

      <div className="device-list">
        {devices.length === 0 ? (
          <div className="device-empty">
            <MonitorUp aria-hidden="true" />
            <strong>还没有运营电脑</strong>
            <span>添加第一台电脑后，它会自动成为草稿执行设备。</span>
          </div>
        ) : (
          devices.map((device) => (
            <article className="device-row" key={device.recordId}>
              <div className={`device-icon${device.enabled ? " is-online" : ""}`}>
                <Laptop aria-hidden="true" />
              </div>
              <div className="device-name">
                <strong>{device.name}</strong>
                <span>{device.paired ? "已完成连接" : "等待输入连接码"}</span>
              </div>
              <div className="device-seen">
                <span>最近连接</span>
                <strong>{lastSeenLabel(device.lastSeenAt)}</strong>
              </div>
              <div className={`device-worker${device.worker ? " is-worker" : ""}`}>
                <Radio aria-hidden="true" />
                {device.worker ? "执行设备" : "备用设备"}
              </div>
              <button
                className="secondary-button"
                disabled={isPending || device.worker || !device.enabled}
                type="button"
                onClick={() => action(async () => {
                  await request(`/api/admin/devices/${device.recordId}`, {
                    method: "PATCH",
                    body: JSON.stringify({ worker: true }),
                  });
                  await load();
                })}
              >
                设为执行设备
              </button>
              <button
                className="device-toggle"
                disabled={isPending}
                type="button"
                aria-label={device.enabled ? `停用${device.name}` : `启用${device.name}`}
                onClick={() => action(async () => {
                  await request(`/api/admin/devices/${device.recordId}`, {
                    method: "PATCH",
                    body: JSON.stringify({ enabled: !device.enabled }),
                  });
                  await load();
                })}
              >
                {isPending ? (
                  <LoaderCircle className="spin" aria-hidden="true" />
                ) : device.enabled ? (
                  <CheckCircle2 aria-hidden="true" />
                ) : (
                  <CircleOff aria-hidden="true" />
                )}
              </button>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
