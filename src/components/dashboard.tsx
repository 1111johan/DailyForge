"use client";

import {
  AlertCircle,
  ArrowRight,
  Check,
  CircleDashed,
  Cloud,
  FileText,
  Image as ImageIcon,
  LoaderCircle,
  LockKeyhole,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Rows3,
  Save,
  Send,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import Image from "next/image";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useTransition,
} from "react";
import type {
  DashboardJob,
  DashboardSnapshot,
} from "@/lib/dashboard/data";
import type { PromptSettings } from "@/lib/settings/prompt-settings-schema";

interface HealthResponse {
  ok: boolean;
  time: string;
  configuration: {
    supabase: boolean;
    ai: boolean;
    feishu: boolean;
    security: boolean;
  };
}

interface ApiEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  processed?: boolean;
  created?: boolean;
  error?: { code: string; message: string };
}

const EMPTY_PROMPTS: PromptSettings = { copyPrompt: "", imagePrompt: "" };

const PIPELINE = [
  { key: "generate_copy", label: "文案", icon: FileText },
  { key: "generate_image_1", label: "图 1", icon: ImageIcon },
  { key: "generate_image_2", label: "图 2", icon: ImageIcon },
  { key: "generate_image_3", label: "图 3", icon: ImageIcon },
  { key: "generate_image_4", label: "图 4", icon: ImageIcon },
  { key: "review_content", label: "检查", icon: ShieldCheck },
  { key: "sync_feishu", label: "飞书", icon: Send },
] as const;

const STATUS_LABELS: Record<DashboardJob["status"], string> = {
  queued: "等待中",
  running: "生成中",
  retry: "待重试",
  completed: "已完成",
  failed: "需处理",
};

const ASSET_STATUS_LABELS: Record<DashboardJob["assets"][number]["status"], string> = {
  pending: "等待生成",
  processing: "正在生成",
  ready: "已经生成",
  failed: "生成失败",
};

const STAGE_LABELS: Record<string, string> = {
  generate_copy: "生成文案",
  generate_image_1: "生成第 1 张图",
  generate_image_2: "生成第 2 张图",
  generate_image_3: "生成第 3 张图",
  generate_image_4: "生成第 4 张图",
  poll_image_1: "等待第 1 张图",
  poll_image_2: "等待第 2 张图",
  poll_image_3: "等待第 3 张图",
  poll_image_4: "等待第 4 张图",
  review_content: "内容检查",
  sync_feishu: "同步飞书",
  completed: "完成",
};

function formatClock(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function normalizedStage(stage: string) {
  return stage.startsWith("poll_image_")
    ? stage.replace("poll_", "generate_")
    : stage;
}

function StatusIcon({ status }: { status: DashboardJob["status"] }) {
  if (status === "completed") return <Check aria-hidden="true" />;
  if (status === "failed") return <X aria-hidden="true" />;
  if (status === "running") {
    return <LoaderCircle className="spin" aria-hidden="true" />;
  }
  if (status === "retry") return <RotateCcw aria-hidden="true" />;
  return <CircleDashed aria-hidden="true" />;
}

function PipelineRail({ job }: { job: DashboardJob | null }) {
  const current = normalizedStage(job?.stage || "generate_copy");
  const currentIndex = PIPELINE.findIndex((step) => step.key === current);
  return (
    <section className="pipeline-band" aria-label="今日生产进度">
      <div className="pipeline-heading">
        <span>今日生产轨道</span>
        <strong>{job ? STATUS_LABELS[job.status] : "等待任务"}</strong>
      </div>
      <div className="pipeline-track">
        {PIPELINE.map((step, index) => {
          const Icon = step.icon;
          const isDone = job?.status === "completed" || index < currentIndex;
          const isCurrent = job?.status !== "completed" && index === currentIndex;
          return (
            <div
              className={`pipeline-step${isDone ? " is-done" : ""}${isCurrent ? " is-current" : ""}`}
              key={step.key}
            >
              <span className="pipeline-node">
                {isDone ? <Check aria-hidden="true" /> : <Icon aria-hidden="true" />}
              </span>
              <span>{step.label}</span>
              {index < PIPELINE.length - 1 ? (
                <ArrowRight className="pipeline-arrow" aria-hidden="true" />
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ConnectionStrip({ health }: { health: HealthResponse | null }) {
  const services = [
    ["supabase", "数据仓库", Cloud],
    ["ai", "AI 中转站", Sparkles],
    ["feishu", "飞书", Rows3],
  ] as const;
  return (
    <div className="connections" aria-label="服务连接状态">
      {services.map(([key, label, Icon]) => {
        const ready = health?.configuration[key] ?? false;
        return (
          <div className={`connection${ready ? " is-ready" : ""}`} key={key}>
            <Icon aria-hidden="true" />
            <span>{label}</span>
            <span className="connection-state">{ready ? "已配置" : "待配置"}</span>
          </div>
        );
      })}
    </div>
  );
}

function SummaryBand({ snapshot }: { snapshot: DashboardSnapshot }) {
  const items = [
    ["今日任务", snapshot.summary.total, "全部"],
    ["正在推进", snapshot.summary.active, "运行"],
    ["已到飞书", snapshot.summary.completed, "完成"],
    ["需要处理", snapshot.summary.failed, "异常"],
  ] as const;
  return (
    <section className="summary-band" aria-label="今日概况">
      {items.map(([label, value, note]) => (
        <div className="summary-item" key={label}>
          <span>{label}</span>
          <div>
            <strong>{String(value).padStart(2, "0")}</strong>
            <small>{note}</small>
          </div>
        </div>
      ))}
    </section>
  );
}

function PromptComposer({
  prompts,
  ready,
  editing,
  saving,
  dirty,
  onChange,
  onEdit,
  onCancel,
  onSave,
}: {
  prompts: PromptSettings;
  ready: boolean;
  editing: boolean;
  saving: boolean;
  dirty: boolean;
  onChange: (key: keyof PromptSettings, value: string) => void;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <section
      className={`prompt-composer${editing ? " is-editing" : ""}`}
      aria-labelledby="prompt-heading"
    >
      <div className="prompt-toolbar">
        <div>
          <p>全局设置</p>
          <h2 id="prompt-heading">小红书生成提示词</h2>
        </div>
        <div className="prompt-actions">
          <span className={`prompt-lock-state${editing ? " is-editing" : ""}`}>
            {editing ? <Pencil aria-hidden="true" /> : <LockKeyhole aria-hidden="true" />}
            {editing ? "编辑中" : "已锁定"}
          </span>
          {editing ? (
            <>
              <button
                className="secondary-button"
                type="button"
                disabled={saving}
                onClick={onCancel}
              >
                <X aria-hidden="true" />取消
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={saving || !dirty}
                onClick={onSave}
              >
                {saving ? (
                  <LoaderCircle className="spin" aria-hidden="true" />
                ) : (
                  <Save aria-hidden="true" />
                )}
                保存提示词
              </button>
            </>
          ) : (
            <button
              className="secondary-button"
              type="button"
              disabled={!ready}
              onClick={onEdit}
            >
              <Pencil aria-hidden="true" />修改提示词
            </button>
          )}
        </div>
      </div>

      <div className="prompt-grid">
        <div className="prompt-field">
          <div className="prompt-heading">
            <label htmlFor="copy-prompt">文案提示词</label>
            <span className="prompt-count">{prompts.copyPrompt.length} / 5000</span>
          </div>
          <textarea
            id="copy-prompt"
            value={prompts.copyPrompt}
            maxLength={5000}
            rows={13}
            readOnly={!editing}
            aria-readonly={!editing}
            placeholder={ready ? undefined : "正在读取提示词"}
            onChange={(event) => onChange("copyPrompt", event.target.value)}
          />
        </div>
        <div className="prompt-field">
          <div className="prompt-heading">
            <label htmlFor="image-prompt">图片提示词</label>
            <span className="prompt-count">{prompts.imagePrompt.length} / 5000</span>
          </div>
          <textarea
            id="image-prompt"
            value={prompts.imagePrompt}
            maxLength={5000}
            rows={13}
            readOnly={!editing}
            aria-readonly={!editing}
            placeholder={ready ? undefined : "正在读取提示词"}
            onChange={(event) => onChange("imagePrompt", event.target.value)}
          />
        </div>
      </div>
    </section>
  );
}

function OutputPreview({ job }: { job: DashboardJob | null }) {
  const slots = [1, 2, 3, 4].map((index) =>
    job?.assets.find((asset) => asset.index === index),
  );

  return (
    <section className="output-preview" aria-labelledby="output-heading">
      <div className="output-heading">
        <div>
          <p>生成结果</p>
          <h2 id="output-heading">文案与图片预览</h2>
        </div>
        {job ? (
          <span className={`status-pill ${job.status}`}>
            <StatusIcon status={job.status} />
            {STATUS_LABELS[job.status]}
          </span>
        ) : null}
      </div>

      {!job ? (
        <div className="output-empty">
          <CircleDashed aria-hidden="true" />
          <strong>还没有可预览的任务</strong>
        </div>
      ) : (
        <div className="output-layout">
          <article className="copy-proof">
            <span>{job.level === "cet4" ? "大学英语四级" : "大学英语六级"}</span>
            <h3>{job.title || job.topic}</h3>
            {job.body ? (
              <>
                <p className="copy-body">{job.body}</p>
                <p className="copy-hashtags">{job.hashtags.join(" ")}</p>
                <small>正文 {job.body.length} 字</small>
              </>
            ) : (
              <div className="copy-pending">
                <LoaderCircle
                  className={job.status === "running" ? "spin" : ""}
                  aria-hidden="true"
                />
                <span>{STAGE_LABELS[job.stage] || job.stage}</span>
              </div>
            )}
          </article>

          <div className="asset-contact-sheet" aria-label="四张生成图片">
            {slots.map((asset, index) => (
              <figure className="preview-asset" key={index + 1}>
                <div>
                  {asset?.url ? (
                    <Image
                      src={asset.url}
                      alt={`${job.title || job.topic}第 ${index + 1} 张图`}
                      fill
                      unoptimized
                      sizes="(max-width: 640px) 48vw, (max-width: 1100px) 24vw, 220px"
                    />
                  ) : (
                    <span className="asset-placeholder">
                      {asset?.status === "processing" ? (
                        <LoaderCircle className="spin" aria-hidden="true" />
                      ) : (
                        <ImageIcon aria-hidden="true" />
                      )}
                      {asset ? ASSET_STATUS_LABELS[asset.status] : "等待文案"}
                    </span>
                  )}
                </div>
                <figcaption>
                  <strong>0{index + 1}</strong>
                  <span>{index === 0 ? "封面" : `内容页 ${index}`}</span>
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function JobRow({
  job,
  selected,
  onSelect,
  onRetry,
  pending,
}: {
  job: DashboardJob;
  selected: boolean;
  onSelect: (jobId: string) => void;
  onRetry: (jobId: string) => void;
  pending: boolean;
}) {
  return (
    <article className={`job-row status-${job.status}${selected ? " is-selected" : ""}`}>
      <div className="job-status-icon">
        <StatusIcon status={job.status} />
      </div>
      <div className="job-date">
        <strong>{job.jobDate.slice(5)}</strong>
        <span>{job.level === "cet4" ? "四级" : "六级"}</span>
      </div>
      <div className="job-main">
        <button
          className="job-preview-button"
          type="button"
          aria-label={`查看${job.title || job.topic}的生成结果`}
          aria-pressed={selected}
          onClick={() => onSelect(job.id)}
        >
          <strong>{job.title || job.topic}</strong>
          <span>{job.productName} · {STAGE_LABELS[job.stage] || job.stage}</span>
        </button>
        {job.errorMessage ? (
          <p className="job-error">
            <AlertCircle aria-hidden="true" /> {job.errorMessage}
          </p>
        ) : null}
      </div>
      <div className="asset-count">
        <ImageIcon aria-hidden="true" />
        <strong>{job.readyAssets}</strong>
        <span>/ 4</span>
      </div>
      <div className="job-progress">
        <div><span style={{ width: `${job.progress}%` }} /></div>
        <small>{job.progress}%</small>
      </div>
      <div className={`status-pill ${job.status}`}>
        <StatusIcon status={job.status} />{STATUS_LABELS[job.status]}
      </div>
      <time>{formatClock(job.updatedAt)}</time>
      <div className="job-action">
        {job.status === "failed" || job.status === "retry" ? (
          <button
            className="icon-button"
            type="button"
            title="重新尝试"
            aria-label="重新尝试"
            disabled={pending}
            onClick={() => onRetry(job.id)}
          >
            <RotateCcw aria-hidden="true" />
          </button>
        ) : <span />}
      </div>
    </article>
  );
}

export function Dashboard() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedProduct, setSelectedProduct] = useState("");
  const [selectedJobId, setSelectedJobId] = useState("");
  const [savedPrompts, setSavedPrompts] = useState<PromptSettings>(EMPTY_PROMPTS);
  const [draftPrompts, setDraftPrompts] = useState<PromptSettings>(EMPTY_PROMPTS);
  const [promptsReady, setPromptsReady] = useState(false);
  const [isEditingPrompts, setIsEditingPrompts] = useState(false);
  const [isSavingPrompts, setIsSavingPrompts] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    fetch("/api/health", { cache: "no-store" })
      .then((response) => response.json() as Promise<HealthResponse>)
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  const apiFetch = useCallback(
    async <T,>(path: string, init?: RequestInit) => {
      const response = await fetch(path, {
        ...init,
        cache: "no-store",
        headers: {
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
          ...init?.headers,
        },
      });
      const result = (await response.json()) as ApiEnvelope<T>;
      if (!response.ok || !result.ok) {
        throw new Error(result.error?.message || "请求未完成");
      }
      return result;
    },
    [],
  );

  const applySnapshot = useCallback((nextSnapshot: DashboardSnapshot) => {
    setSnapshot(nextSnapshot);
    setSelectedProduct((current) => current || nextSnapshot.products[0]?.id || "");
    setSelectedJobId((current) => {
      if (nextSnapshot.jobs.some((job) => job.id === current)) return current;
      return nextSnapshot.jobs.find((job) => job.title)?.id || nextSnapshot.jobs[0]?.id || "";
    });
  }, []);

  const loadDashboard = useCallback(async () => {
    const result = await apiFetch<DashboardSnapshot>("/api/dashboard");
    if (!result.data) throw new Error("运行台返回空数据");
    applySnapshot(result.data);
  }, [apiFetch, applySnapshot]);

  useEffect(() => {
    apiFetch<DashboardSnapshot>("/api/dashboard")
      .then((result) => {
        if (!result.data) throw new Error("运行台返回空数据");
        applySnapshot(result.data);
      })
      .catch((caught) => {
        const now = new Date();
        setError(caught instanceof Error ? caught.message : "无法读取运行台数据");
        applySnapshot({
          generatedAt: now.toISOString(),
          today: new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Shanghai",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(now),
          summary: { total: 0, completed: 0, active: 0, failed: 0 },
          products: [],
          jobs: [],
        });
      })
      .finally(() => setIsLoading(false));
  }, [apiFetch, applySnapshot]);

  useEffect(() => {
    apiFetch<PromptSettings>("/api/settings/prompts")
      .then((result) => {
        if (!result.data) throw new Error("提示词返回空数据");
        setSavedPrompts(result.data);
        setDraftPrompts(result.data);
        setPromptsReady(true);
      })
      .catch((caught) => {
        setError(caught instanceof Error ? caught.message : "无法读取提示词");
      });
  }, [apiFetch]);

  function runAction(action: () => Promise<string>) {
    setNotice(null);
    setError(null);
    startTransition(async () => {
      try {
        setNotice(await action());
        await loadDashboard();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "操作未完成");
      }
    });
  }

  async function savePrompts() {
    const copyPrompt = draftPrompts.copyPrompt.trim();
    const imagePrompt = draftPrompts.imagePrompt.trim();
    if (!copyPrompt || !imagePrompt) {
      setError("文案提示词和图片提示词都不能为空");
      return;
    }

    setIsSavingPrompts(true);
    setError(null);
    setNotice(null);
    try {
      const result = await apiFetch<PromptSettings>("/api/settings/prompts", {
        method: "PUT",
        body: JSON.stringify({ copyPrompt, imagePrompt }),
      });
      if (!result.data) throw new Error("保存后未返回提示词");
      setSavedPrompts(result.data);
      setDraftPrompts(result.data);
      setIsEditingPrompts(false);
      setNotice("提示词已保存到 Supabase");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "提示词保存失败");
    } finally {
      setIsSavingPrompts(false);
    }
  }

  const primaryJob = useMemo(() => {
    if (!snapshot) return null;
    return (
      snapshot.jobs.find(
        (job) => job.jobDate === snapshot.today && job.status !== "completed",
      ) || snapshot.jobs.find((job) => job.jobDate === snapshot.today) || null
    );
  }, [snapshot]);

  const selectedJob = useMemo(
    () => snapshot?.jobs.find((job) => job.id === selectedJobId) || null,
    [selectedJobId, snapshot],
  );

  const promptsDirty =
    draftPrompts.copyPrompt !== savedPrompts.copyPrompt ||
    draftPrompts.imagePrompt !== savedPrompts.imagePrompt;

  if (isLoading || !snapshot) {
    return (
      <main className="app-shell loading-shell" aria-busy="true">
        <LoaderCircle className="spin" aria-hidden="true" />
        <span>正在读取运行台</span>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="brand-header dashboard-header">
        <div>
          <p className="brand-kicker">CONTENT OPERATIONS / {snapshot.today}</p>
          <h1>DailyForge <span>Lite</span></h1>
        </div>
        <div className="header-actions">
          <span className="live-state"><span /> 系统在线</span>
          <button
            className="icon-button"
            type="button"
            title="刷新任务"
            aria-label="刷新任务"
            disabled={isPending}
            onClick={() => runAction(async () => {
              await loadDashboard();
              return "任务已刷新";
            })}
          >
            <RefreshCw className={isPending ? "spin" : ""} aria-hidden="true" />
          </button>
        </div>
      </header>
      <PipelineRail job={primaryJob} />
      <ConnectionStrip health={health} />
      <SummaryBand snapshot={snapshot} />

      <PromptComposer
        prompts={draftPrompts}
        ready={promptsReady}
        editing={isEditingPrompts}
        saving={isSavingPrompts}
        dirty={promptsDirty}
        onChange={(key, value) => {
          setDraftPrompts((current) => ({ ...current, [key]: value }));
        }}
        onEdit={() => setIsEditingPrompts(true)}
        onCancel={() => {
          setDraftPrompts(savedPrompts);
          setIsEditingPrompts(false);
          setError(null);
        }}
        onSave={savePrompts}
      />

      <section className="operations-bar" aria-label="任务操作">
        <div className="section-title">
          <h2>任务队列</h2>
          <strong>{snapshot.jobs.length} 条记录</strong>
        </div>
        <div className="operation-controls">
          <label>
            <span className="sr-only">选择产品</span>
            <select
              value={selectedProduct}
              onChange={(event) => setSelectedProduct(event.target.value)}
            >
              {snapshot.products.length === 0 ? (
                <option value="">暂无启用产品</option>
              ) : null}
              {snapshot.products.map((product) => (
                <option value={product.id} key={product.id}>{product.name}</option>
              ))}
            </select>
          </label>
          <button
            className="secondary-button"
            type="button"
            disabled={isPending}
            onClick={() => runAction(async () => {
              const result = await apiFetch("/api/manual/run-worker", {
                method: "POST",
                body: "{}",
              });
              return result.processed
                ? "已推进一个生产步骤"
                : "当前没有待处理任务";
            })}
          >
            <Play aria-hidden="true" />推进一步
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={isPending || !selectedProduct || !promptsReady}
            onClick={() => runAction(async () => {
              const result = await apiFetch("/api/manual/generate", {
                method: "POST",
                body: JSON.stringify({
                  productId: selectedProduct,
                  customPrompt: savedPrompts.copyPrompt,
                  imagePrompt: savedPrompts.imagePrompt,
                }),
              });
              return result.created ? "今日任务已创建" : "今日任务已经存在";
            })}
          >
            <Plus aria-hidden="true" />创建今日任务
          </button>
        </div>
      </section>

      {notice || error ? (
        <div
          className={`notice${error ? " is-error" : ""}`}
          role={error ? "alert" : "status"}
        >
          {error ? <AlertCircle aria-hidden="true" /> : <Check aria-hidden="true" />}
          <span>{error || notice}</span>
          <button
            className="icon-button"
            type="button"
            title="关闭"
            aria-label="关闭"
            onClick={() => {
              setError(null);
              setNotice(null);
            }}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      ) : null}

      <OutputPreview job={selectedJob} />

      <section className="jobs-section" aria-label="任务记录">
        <div className="job-table-head" aria-hidden="true">
          <span />
          <span>日期</span>
          <span>内容</span>
          <span>图片</span>
          <span>进度</span>
          <span>状态</span>
          <span>更新</span>
          <span />
        </div>
        <div className="job-list">
          {snapshot.jobs.length === 0 ? (
            <div className="empty-state">
              <CircleDashed aria-hidden="true" />
              <strong>今天还没有任务</strong>
            </div>
          ) : snapshot.jobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              selected={job.id === selectedJobId}
              pending={isPending}
              onSelect={setSelectedJobId}
              onRetry={(jobId) => runAction(async () => {
                await apiFetch("/api/manual/retry", {
                  method: "POST",
                  body: JSON.stringify({ jobId }),
                });
                return "任务已重新加入队列";
              })}
            />
          ))}
        </div>
      </section>

      <footer className="app-footer">
        <span><ShieldCheck aria-hidden="true" /> DailyForge 运行台</span>
        <span>最近刷新 {formatClock(snapshot.generatedAt)}</span>
      </footer>
    </main>
  );
}
