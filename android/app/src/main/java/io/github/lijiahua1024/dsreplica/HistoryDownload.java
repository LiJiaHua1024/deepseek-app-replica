package io.github.lijiahua1024.dsreplica;

import android.content.Context;
import android.util.Base64;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 导出包的链接下载。
 *
 * WebView 里的 fetch 受 CORS 限制（DeepSeek 的导出链接不带跨域头），
 * 所以由原生下载到缓存目录，再按块以 base64 交给前端拼成 File 交给现有导入流程。
 * 前端拿到的是普通 File，导入管线一行都不用改。
 */
final class HistoryDownload {

    interface Progress {
        void onEvent(String state, long loaded, long total, String message);
    }

    private final Map<String, File> files = new ConcurrentHashMap<>();
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    /** 开始下载，返回令牌；地址非法时返回空串 */
    String start(Context context, String address, Progress progress) {
        String target = address == null ? "" : address.trim();
        if (!target.startsWith("http://") && !target.startsWith("https://")) {
            return "";
        }
        String token = Long.toHexString(System.nanoTime());
        File file = new File(context.getCacheDir(), "history-" + token + ".zip");
        files.put(token, file);
        executor.execute(() -> download(target, token, file, progress));
        return token;
    }

    private void download(String address, String token, File target, Progress progress) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(address).openConnection();
            connection.setConnectTimeout(20000);
            connection.setReadTimeout(60000);
            connection.setInstanceFollowRedirects(true);
            connection.setRequestProperty("User-Agent", "DeepSeekDesk");
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) {
                progress.onEvent("error", 0, 0, "HTTP " + status);
                return;
            }
            long total = connection.getContentLengthLong();
            long loaded = 0;
            long reported = 0;
            try (InputStream input = connection.getInputStream();
                 FileOutputStream output = new FileOutputStream(target)) {
                byte[] buffer = new byte[64 * 1024];
                for (int read; (read = input.read(buffer)) > 0; ) {
                    output.write(buffer, 0, read);
                    loaded += read;
                    if (loaded - reported >= 128 * 1024) {
                        reported = loaded;
                        progress.onEvent("progress", loaded, total, "");
                    }
                }
            }
            progress.onEvent("progress", loaded, total, "");
            progress.onEvent("ready", loaded, loaded, "");
        } catch (IOException error) {
            //noinspection ResultOfMethodCallIgnored
            target.delete();
            files.remove(token);
            progress.onEvent("error", 0, 0, String.valueOf(error.getMessage()));
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    long size(String token) {
        File file = files.get(token);
        return file != null && file.isFile() ? file.length() : -1;
    }

    /** 读取一段并返回 base64；越界或文件不存在返回空串 */
    String read(String token, long offset, int length) {
        File file = files.get(token);
        if (file == null || !file.isFile() || length <= 0 || offset < 0) {
            return "";
        }
        long size = file.length();
        if (offset >= size) {
            return "";
        }
        int want = (int) Math.min(length, size - offset);
        try (FileInputStream input = new FileInputStream(file)) {
            long skipped = 0;
            while (skipped < offset) {
                long step = input.skip(offset - skipped);
                if (step <= 0) {
                    return "";
                }
                skipped += step;
            }
            ByteArrayOutputStream buffer = new ByteArrayOutputStream(want);
            byte[] chunk = new byte[Math.min(64 * 1024, want)];
            int remaining = want;
            while (remaining > 0) {
                int read = input.read(chunk, 0, Math.min(chunk.length, remaining));
                if (read <= 0) {
                    break;
                }
                buffer.write(chunk, 0, read);
                remaining -= read;
            }
            return Base64.encodeToString(buffer.toByteArray(), Base64.NO_WRAP);
        } catch (IOException error) {
            return "";
        }
    }

    void release(String token) {
        File file = files.remove(token);
        if (file != null) {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
        }
    }

    void shutdown() {
        executor.shutdownNow();
        for (String token : files.keySet()) {
            release(token);
        }
    }
}
