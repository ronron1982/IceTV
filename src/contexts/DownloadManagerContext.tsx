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

function triggerDownload(url: string, title: string) {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${title || 'icetv-video'}.mp4`;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
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
      throw new Error('M3U8 播放清单必须使用「FFmpeg 转存下载」');
    }
    const response = await fetch(task.url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`下载失败（${response.status}）`);
    const blobUrl = URL.createObjectURL(await response.blob());
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
          await runBrowserDownload(task);
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
                    <div className='text-xs text-gray-500'>
                      {task.status === 'completed'
                        ? '已完成'
                        : task.status === 'error'
                          ? task.error || '失败'
                          : `${task.channel === 'ffmpeg' ? 'FFmpeg 转存' : '浏览器下载'} ${Math.round(task.progress)}%`}
                    </div>
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
