'use client';

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import { readStorage, writeStorage } from '@/lib/browser-storage';

export type DownloadChannel = 'browser' | 'ffmpeg';
export type DownloadStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'error';

export type DownloadTask = {
  id: string;
  title: string;
  url: string;
  channel: DownloadChannel;
  status: DownloadStatus;
  progress: number;
  ffmpegJobId?: string;
  downloadUrl?: string;
  error?: string;
};

export type DownloadRequest = {
  title: string;
  url: string;
  channel?: DownloadChannel;
};

type DownloadContextValue = {
  tasks: DownloadTask[];
  enqueueDownload: (request: DownloadRequest) => Promise<string>;
  openManager: () => void;
};

const STORAGE_KEY = 'icetv-download-tasks';
const DownloadContext = createContext<DownloadContextValue | null>(null);

function isM3u8(url: string): boolean {
  try {
    return new URL(url, window.location.origin).pathname
      .toLowerCase()
      .endsWith('.m3u8');
  } catch {
    return /\.m3u8(?:$|[?#])/i.test(url);
  }
}

function absoluteUrl(url: string): string {
  return new URL(url, window.location.origin).toString();
}

function triggerDownload(url: string, title: string, extension = 'mp4') {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${title || 'icetv-video'}.${extension}`;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

async function downloadWithProgress(
  url: string,
  onProgress: (received: number, total: number) => void,
): Promise<Blob> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`下载失败（${response.status}）`);
  if (!response.body) return response.blob();

  const contentLength = Number(response.headers.get('content-length') || 0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.byteLength;
      onProgress(received, contentLength);
    }
  }
  return new Blob(chunks as BlobPart[], { type: response.headers.get('content-type') || 'application/octet-stream' });
}

function resolvePlaylistUrl(rawUrl: string, baseUrl: string): string {
  if (/^https?:\/\//i.test(rawUrl)) return rawUrl;
  return new URL(rawUrl, baseUrl).toString();
}

async function parseM3u8(url: string, depth = 0): Promise<{ segments: string[] }> {
  if (depth > 5) throw new Error('M3U8 解析层级过深');
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`读取播放清单失败（${response.status}）`);
  const content = await response.text();
  if (!content.trim().toUpperCase().startsWith('#EXTM3U')) {
    throw new Error('无效的 M3U8 播放清单');
  }
  if (content.includes('#EXT-X-KEY')) {
    throw new Error('加密 M3U8 暂不支持浏览器分片下载');
  }

  const lines = content.split(/\r?\n/).map((line) => line.trim());
  const variants: Array<{ url: string; bandwidth: number }> = [];
  let pendingBandwidth = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const bandwidth = /BANDWIDTH=(\d+)/i.exec(lines[i]);
      pendingBandwidth = bandwidth ? Number(bandwidth[1]) : 0;
    } else if (pendingBandwidth && lines[i] && !lines[i].startsWith('#')) {
      variants.push({ url: resolvePlaylistUrl(lines[i], url), bandwidth: pendingBandwidth });
      pendingBandwidth = 0;
    }
  }
  if (variants.length > 0) {
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    return parseM3u8(variants[0].url, depth + 1);
  }

  const segments = lines
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => resolvePlaylistUrl(line, url));
  if (segments.length === 0) throw new Error('播放清单中没有可下载的分片');
  return { segments };
}

async function downloadM3u8(
  url: string,
  onProgress: (progress: number) => void,
): Promise<Blob> {
  const { segments } = await parseM3u8(absoluteUrl(url));
  const buffers = new Array<ArrayBuffer>(segments.length);
  let completed = 0;
  let cursor = 0;
  const workerCount = Math.min(6, segments.length);

  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < segments.length) {
      const index = cursor;
      cursor += 1;
      const segmentUrl = segments[index];
      const blob = await downloadWithProgress(segmentUrl, () => undefined);
      const buffer = await blob.arrayBuffer();
      buffers[index] = buffer;
      completed += 1;
      onProgress((completed / segments.length) * 100);
    }
  });
  await Promise.all(workers);
  return new Blob(buffers as BlobPart[], { type: 'video/mp2t' });
}

function patchTask(
  setTasks: React.Dispatch<React.SetStateAction<DownloadTask[]>>,
  id: string,
  patch: Partial<DownloadTask>,
) {
  setTasks((current) =>
    current.map((task) => (task.id === id ? { ...task, ...patch } : task)),
  );
}

async function requestFfmpeg(
  body:
    | {
        action: 'start';
        sourceUrl: string;
        title: string;
        fileNameHint: string;
      }
    | { action: 'pause' | 'resume' | 'remove'; id: string },
) {
  const response = await fetch('/api/download/ffmpeg', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const payload = (await response.json().catch(() => ({}))) as {
    job?: {
      id: string;
      status: DownloadStatus;
      progress: number;
      downloadUrl?: string | null;
    };
    error?: string;
    details?: string;
  };
  if (!response.ok || !payload.job) {
    throw new Error(
      payload.details ||
        payload.error ||
        `FFmpeg 请求失败（${response.status}）`,
    );
  }
  return payload.job;
}

async function getFfmpegJob(id: string) {
  const response = await fetch(
    `/api/download/ffmpeg?id=${encodeURIComponent(id)}`,
    { cache: 'no-store' },
  );
  const payload = (await response.json()) as {
    job?: {
      status: DownloadStatus;
      progress: number;
      downloadUrl?: string | null;
      error?: string;
    };
  };
  if (!response.ok || !payload.job) {
    throw new Error('无法取得 FFmpeg 任务状态');
  }
  return payload.job;
}

export function DownloadManagerProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    try {
      const saved = JSON.parse(readStorage(STORAGE_KEY) || '[]');
      if (Array.isArray(saved)) setTasks(saved);
    } catch {
      setTasks([]);
    }
  }, []);

  useEffect(() => {
    writeStorage(STORAGE_KEY, JSON.stringify(tasks));
  }, [tasks]);

  const runBrowserDownload = useCallback(async (task: DownloadTask) => {
    if (isM3u8(task.url)) {
      const blob = await downloadM3u8(task.url, (progress) => {
        patchTask(setTasks, task.id, {
          status: 'downloading',
          progress,
        });
      });
      const blobUrl = URL.createObjectURL(blob);
      triggerDownload(blobUrl, task.title, 'ts');
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
      return;
    }
    const blob = await downloadWithProgress(task.url, (received, total) => {
      const progress =
        total > 0 ? Math.min(99.5, (received / total) * 100) : 0;
      patchTask(setTasks, task.id, { status: 'downloading', progress });
    });
    const blobUrl = URL.createObjectURL(blob);
    triggerDownload(blobUrl, task.title);
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
  }, []);

  const runFfmpegDownload = useCallback(async (task: DownloadTask) => {
    const job = await requestFfmpeg({
      action: 'start',
      sourceUrl: absoluteUrl(task.url),
      title: task.title,
      fileNameHint: task.title,
    });
    patchTask(setTasks, task.id, {
      status: job.status,
      progress: job.progress,
      ffmpegJobId: job.id,
    });

    let completedDownloadUrl = job.downloadUrl || '';
    while (job.status !== 'completed' && job.status !== 'error') {
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
      const next = await getFfmpegJob(job.id);
      patchTask(setTasks, task.id, {
        status: next.status,
        progress: next.progress,
        error: next.error,
        downloadUrl: next.downloadUrl || undefined,
      });
      if (next.downloadUrl) completedDownloadUrl = next.downloadUrl;
      if (next.status === 'completed' || next.status === 'error') break;
    }
    if (!completedDownloadUrl) {
      throw new Error('FFmpeg 转存失败或未产生输出文件');
    }
    triggerDownload(completedDownloadUrl, task.title);
  }, []);

  const enqueueDownload = useCallback(
    async ({ title, url, channel = 'browser' }: DownloadRequest) => {
      const id = crypto.randomUUID();
      const task: DownloadTask = {
        id,
        title,
        url,
        channel,
        status: 'queued',
        progress: 0,
      };
      setTasks((current) => [task, ...current]);
      setIsOpen(true);
      patchTask(setTasks, id, { status: 'starting' });

      try {
        if (channel === 'ffmpeg') {
          await runFfmpegDownload(task);
        } else {
          try {
            await runBrowserDownload(task);
          } catch (error) {
            if (!isM3u8(task.url)) throw error;
            patchTask(setTasks, id, {
              channel: 'ffmpeg',
              status: 'starting',
              progress: 0,
            });
            await runFfmpegDownload({ ...task, channel: 'ffmpeg' });
          }
        }
        patchTask(setTasks, id, { status: 'completed', progress: 100 });
      } catch (error) {
        patchTask(setTasks, id, {
          status: 'error',
          error: error instanceof Error ? error.message : '下载失败',
        });
      }
      return id;
    },
    [runBrowserDownload, runFfmpegDownload],
  );

  const value = useMemo(
    () => ({ tasks, enqueueDownload, openManager: () => setIsOpen(true) }),
    [enqueueDownload, tasks],
  );

  return (
    <DownloadContext.Provider value={value}>
      {children}
      {isOpen && (
        <div className='fixed inset-0 z-[1000] flex items-end justify-end bg-black/30 p-4'>
          <section className='w-full max-w-md rounded-xl bg-white p-4 shadow-xl dark:bg-gray-900'>
            <div className='mb-3 flex items-center justify-between'>
              <h2 className='font-semibold'>下载管理</h2>
              <button type='button' onClick={() => setIsOpen(false)}>
                关闭
              </button>
            </div>
            {tasks.length === 0 ? (
              <p className='text-sm text-gray-500'>暂无下载任务</p>
            ) : (
              <ul className='space-y-2 text-sm'>
                {tasks.map((task) => (
                  <li
                    key={task.id}
                    className='rounded-lg bg-gray-100 p-2 dark:bg-gray-800'
                  >
                    <div className='truncate'>{task.title}</div>
                    {task.status === 'error' ? (
                      <div className='text-xs text-red-500'>{task.error || '失败'}</div>
                    ) : (
                      <>
                        <div className='mt-1 flex items-center justify-between text-xs text-gray-500'>
                          <span>{task.channel === 'ffmpeg' ? 'FFmpeg 转存' : '浏览器下载'}</span>
                          <span>{task.status === 'completed' ? '已完成' : `${Math.round(task.progress)}%`}</span>
                        </div>
                        <div className='mt-2 h-2 overflow-hidden rounded-full bg-gray-300 dark:bg-gray-700'>
                          <div
                            className={`h-full transition-[width] duration-300 ${
                              task.status === 'completed'
                                ? 'bg-green-500'
                                : task.status === 'paused'
                                  ? 'bg-yellow-500'
                                  : 'bg-blue-500'
                            }`}
                            style={{ width: `${Math.max(0, Math.min(100, task.progress))}%` }}
                          />
                        </div>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </DownloadContext.Provider>
  );
}

export function useDownloadManager() {
  const context = useContext(DownloadContext);
  if (!context) {
    throw new Error(
      'useDownloadManager must be used within DownloadManagerProvider',
    );
  }
  return context;
}
