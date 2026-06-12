import { defineConfig } from "prisma/config";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env["LOG_DB_URL"] || `file:${path.join(__dirname, "data/logs.db")}`,
  },
});
