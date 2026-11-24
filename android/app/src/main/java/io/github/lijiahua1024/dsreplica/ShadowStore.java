package io.github.lijiahua1024.dsreplica;

import android.content.Context;
import android.util.Base64;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.util.Arrays;
import java.util.regex.Pattern;

/**
 * 聊天数据的原生文件影子镜像，写在应用私有目录 filesDir/chat-shadow 下：
 * sessions/<id>.json 保存会话详情，files/<id>.bin 保存附件原件。
 *
 * WebView 的 IndexedDB 可能被系统或 Chromium 静默清空重建（整库丢失），
 * 该镜像用于在检测到空库时把数据恢复回 IndexedDB。写操作都是主存储成功之后的
 * 增量同步，失败只记录日志，不影响主流程。
 */
final class ShadowStore {
    /** 只允许 sessions/ 或 files/ 下的安全文件名，防止路径穿越。 */
    private static final Pattern SAFE_PATH =
        Pattern.compile("^(sessions|files)/[A-Za-z0-9_-]{1,128}\\.(json|bin)$");
    private static final int MAX_CHUNK_BASE64 = 2_000_000;

    private final File root;
    private OutputStream current;
    private File currentTmp;
    private File currentTarget;

    ShadowStore(Context context) {
        this.root = new File(context.getFilesDir(), "chat-shadow");
    }

    private File resolve(String path) {
        if (!SAFE_PATH.matcher(path).matches()) return null;
        return new File(root, path);
    }

    private static File dir(File root, String name) {
        if (!"sessions".equals(name) && !"files".equals(name)) return null;
        return new File(root, name);
    }

    synchronized boolean begin(String path) {
        closeCurrent(false);
        File target = resolve(path);
        if (target == null) return false;
        File parent = target.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) return false;
        File tmp = new File(target.getPath() + ".tmp");
        try {
            current = new BufferedOutputStream(new FileOutputStream(tmp));
            currentTmp = tmp;
            currentTarget = target;
            return true;
        } catch (IOException | SecurityException e) {
            closeCurrent(false);
            return false;
        }
    }

    synchronized boolean append(String base64) {
        if (current == null || base64 == null || base64.length() > MAX_CHUNK_BASE64) return false;
        try {
            current.write(Base64.decode(base64, Base64.NO_WRAP));
            return true;
        } catch (IOException | IllegalArgumentException e) {
            closeCurrent(false);
            return false;
        }
    }

    /** keep 为 true 时把临时文件原子替换为正式文件；false 直接放弃。 */
    synchronized boolean finish(boolean keep) {
        if (current == null) return false;
        try {
            current.close();
        } catch (IOException ignored) {
            // 关闭失败时下面 rename 仍可能成功，交给 rename 的结果判断。
        } finally {
            current = null;
        }
        File tmp = currentTmp;
        File target = currentTarget;
        currentTmp = null;
        currentTarget = null;
        if (!keep) {
            if (tmp != null) tmp.delete();
            return true;
        }
        if (tmp == null || target == null) return false;
        try {
            if (target.exists() && !target.delete()) return false;
            return tmp.renameTo(target);
        } catch (SecurityException e) {
            tmp.delete();
            return false;
        }
    }

    synchronized void close() {
        closeCurrent(false);
    }

    private void closeCurrent(boolean keep) {
        if (current == null) {
            if (!keep && currentTmp != null) currentTmp.delete();
            currentTmp = null;
            currentTarget = null;
            return;
        }
        try {
            current.close();
        } catch (IOException ignored) {
        }
        current = null;
        if (!keep && currentTmp != null) currentTmp.delete();
        currentTmp = null;
        currentTarget = null;
    }

    /** 列出某个目录下的 id（去掉扩展名），返回 JSON 数组。 */
    synchronized String list(String dirName) {
        File dir = dir(root, dirName);
        String suffix = "sessions".equals(dirName) ? ".json" : ".bin";
        String[] names = dir != null && dir.isDirectory()
            ? dir.list((d, name) -> name.endsWith(suffix) && !name.endsWith(".tmp"))
            : null;
        StringBuilder json = new StringBuilder("[");
        if (names != null) {
            Arrays.sort(names);
            boolean first = true;
            for (String name : names) {
                if (!first) json.append(',');
                first = false;
                json.append('"').append(name, 0, name.length() - suffix.length()).append('"');
            }
        }
        return json.append(']').toString();
    }

    /** 读取文件片段并返回 base64；offset 越界或读到末尾返回 null。 */
    synchronized String readChunk(String path, long offset, int maxBytes) {
        File file = resolve(path);
        if (file == null || !file.isFile() || offset < 0 || maxBytes <= 0) return null;
        try (RandomAccessFile raf = new RandomAccessFile(file, "r")) {
            if (offset >= raf.length()) return null;
            int size = (int) Math.min(maxBytes, raf.length() - offset);
            byte[] buffer = new byte[size];
            raf.seek(offset);
            raf.readFully(buffer);
            return Base64.encodeToString(buffer, Base64.NO_WRAP);
        } catch (IOException | SecurityException e) {
            return null;
        }
    }

    synchronized boolean delete(String path) {
        File file = resolve(path);
        if (file == null) return false;
        try {
            File tmp = new File(file.getPath() + ".tmp");
            tmp.delete();
            return !file.exists() || file.delete();
        } catch (SecurityException e) {
            return false;
        }
    }

    /** 清空整个镜像（删除所有历史、覆盖导入提交后调用），尽量保证成功。 */
    synchronized boolean clearAll() {
        closeCurrent(false);
        boolean ok = true;
        for (String name : new String[]{"sessions", "files"}) {
            File dir = dir(root, name);
            ok &= deleteTree(dir);
            if (!dir.isDirectory() && !dir.mkdirs()) ok = false;
        }
        return ok;
    }

    private static boolean deleteTree(File file) {
        if (!file.exists()) return true;
        File[] children = file.listFiles();
        boolean ok = true;
        if (children != null) {
            for (File child : children) {
                ok &= deleteTree(child);
            }
        }
        try {
            return file.delete() && ok;
        } catch (SecurityException e) {
            return false;
        }
    }
}
