import fs from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function ensureDirForFile(filePath) {
  await ensureDir(path.dirname(filePath));
}

export async function readJson(filePath, fallback = undefined) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return text.trim() ? JSON.parse(text) : fallback;
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) {
      return fallback;
    }
    throw error;
  }
}

export async function writeJson(filePath, value) {
  await ensureDirForFile(filePath);
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

export async function writeText(filePath, value) {
  await ensureDirForFile(filePath);
  await fs.writeFile(filePath, value, "utf8");
}

export function toCsv(rows, columns) {
  const escape = (value) => {
    if (value === null || value === undefined) return "";
    const text = Array.isArray(value) ? value.join(";") : String(value);
    if (/[",\n\r]/.test(text)) {
      return `"${text.replaceAll('"', '""')}"`;
    }
    return text;
  };

  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => escape(row[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}
