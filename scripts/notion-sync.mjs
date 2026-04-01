#!/usr/bin/env node

import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const NOTION_VERSION = "2025-09-03";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const stateDir = path.join(repoRoot, ".notion-sync");

loadEnvFile(path.join(repoRoot, ".env"));

const config = {
  token: process.env.NOTION_API_TOKEN,
  dataSourceId: process.env.NOTION_DATA_SOURCE_ID,
  databaseId: process.env.NOTION_DATABASE_ID,
  titleProperty: process.env.NOTION_TITLE_PROPERTY || "Name",
  slugProperty: process.env.NOTION_SLUG_PROPERTY || "Slug",
  dateProperty: process.env.NOTION_DATE_PROPERTY || "Date",
  descriptionProperty: process.env.NOTION_DESCRIPTION_PROPERTY || "Description",
  tagsProperty: process.env.NOTION_TAGS_PROPERTY || "Tags",
  categoriesProperty: process.env.NOTION_CATEGORIES_PROPERTY || "Categories",
  topicsProperty: process.env.NOTION_TOPICS_PROPERTY || "Topics",
  statusProperty: process.env.NOTION_STATUS_PROPERTY || "Status",
  draftProperty: process.env.NOTION_DRAFT_PROPERTY || "Draft",
  publishedValue: process.env.NOTION_PUBLISHED_VALUE || "Published",
  syncPublishedOnly: parseBoolean(process.env.NOTION_SYNC_PUBLISHED_ONLY, true),
  defaultCategories: splitCsv(process.env.NOTION_DEFAULT_CATEGORIES || "engineering"),
  defaultTopics: splitCsv(process.env.NOTION_DEFAULT_TOPICS || ""),
  outputDir: path.resolve(repoRoot, process.env.NOTION_OUTPUT_DIR || "content/posts"),
};

if (process.argv.includes("--help")) {
  printHelp();
  process.exit(0);
}

main().catch((error) => {
  console.error(`\n[notion-sync] ${error.message}`);
  process.exitCode = 1;
});

async function main() {
  validateConfig(config);

  await fs.mkdir(config.outputDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });

  const managedPosts = await scanManagedPosts(config.outputDir);
  const dataSource = await resolveDataSource(config);
  const pages = await queryAllPages(dataSource.id);

  const syncedPages = filterPagesForSync(pages, config);
  console.log(`[notion-sync] Found ${pages.length} page(s), syncing ${syncedPages.length}.`);

  for (const page of syncedPages) {
    await syncPage({
      page,
      dataSource,
      managedPosts,
      config,
    });
  }

  console.log("[notion-sync] Sync complete.");
}

function printHelp() {
  console.log(`Usage: npm run notion:sync

Required:
  NOTION_API_TOKEN
  NOTION_DATA_SOURCE_ID or NOTION_DATABASE_ID

Optional property mapping:
  NOTION_TITLE_PROPERTY
  NOTION_SLUG_PROPERTY
  NOTION_DATE_PROPERTY
  NOTION_DESCRIPTION_PROPERTY
  NOTION_TAGS_PROPERTY
  NOTION_CATEGORIES_PROPERTY
  NOTION_TOPICS_PROPERTY
  NOTION_STATUS_PROPERTY
  NOTION_DRAFT_PROPERTY
`);
}

function loadEnvFile(filePath) {
  try {
    const raw = readFileSync(filePath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const index = trimmed.indexOf("=");
      if (index === -1) {
        continue;
      }

      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function validateConfig(currentConfig) {
  if (!currentConfig.token) {
    throw new Error("Missing NOTION_API_TOKEN. Copy .env.example to .env and fill it in.");
  }

  if (!currentConfig.dataSourceId && !currentConfig.databaseId) {
    throw new Error(
      "Set NOTION_DATA_SOURCE_ID or NOTION_DATABASE_ID so the sync knows which Notion source to read.",
    );
  }
}

async function resolveDataSource(currentConfig) {
  if (currentConfig.dataSourceId) {
    const dataSource = await notionRequest(`/v1/data_sources/${currentConfig.dataSourceId}`);
    return dataSource;
  }

  const database = await notionRequest(`/v1/databases/${currentConfig.databaseId}`);
  const sources = Array.isArray(database.data_sources) ? database.data_sources : [];

  if (sources.length === 0) {
    throw new Error("The provided database does not expose any data sources.");
  }

  if (sources.length > 1) {
    const sourceNames = sources.map((source) => source.name || source.id).join(", ");
    throw new Error(
      `This database has multiple data sources (${sourceNames}). Set NOTION_DATA_SOURCE_ID explicitly.`,
    );
  }

  return notionRequest(`/v1/data_sources/${sources[0].id}`);
}

async function queryAllPages(dataSourceId) {
  const results = [];
  let nextCursor = null;

  do {
    const body = {
      page_size: 100,
    };

    if (nextCursor) {
      body.start_cursor = nextCursor;
    }

    const response = await notionRequest(`/v1/data_sources/${dataSourceId}/query`, {
      method: "POST",
      body,
    });

    for (const item of response.results || []) {
      if (item.object === "page") {
        results.push(item);
      }
    }

    nextCursor = response.has_more ? response.next_cursor : null;
  } while (nextCursor);

  return results;
}

function filterPagesForSync(pages, currentConfig) {
  if (!currentConfig.syncPublishedOnly) {
    return pages;
  }

  return pages.filter((page) => {
    const statusValue = getPropertyString(page.properties?.[currentConfig.statusProperty]);
    if (!statusValue) {
      return false;
    }

    return statusValue === currentConfig.publishedValue;
  });
}

async function syncPage({ page, dataSource, managedPosts, config: currentConfig }) {
  const titlePropertyName = pickTitlePropertyName(dataSource, currentConfig.titleProperty);
  const title = getPropertyString(page.properties?.[titlePropertyName]) || "Untitled";
  const slugSource = getPropertyString(page.properties?.[currentConfig.slugProperty]) || title;
  const slug = slugify(slugSource) || page.id.replace(/-/g, "");
  const outputPath = path.join(currentConfig.outputDir, `${slug}.md`);
  const assetDir = path.join(currentConfig.outputDir, `${slug}-img`);

  await ensureSafeTarget({
    pageId: page.id,
    slug,
    outputPath,
    assetDir,
    managedPosts,
  });

  const pageCover = await resolvePageCover(page, assetDir);
  const ctx = {
    slug,
    assetDir,
    assetCounter: 1,
  };

  const blocks = await fetchBlockChildren(page.id);
  const body = (await renderBlocks(blocks, ctx)).trim();
  const description = getPropertyString(page.properties?.[currentConfig.descriptionProperty]);
  const propertyCategories = getPropertyStringArray(page.properties?.[currentConfig.categoriesProperty]);
  const propertyTopics = getPropertyStringArray(page.properties?.[currentConfig.topicsProperty]);
  const categories = propertyCategories.length > 0 ? propertyCategories : currentConfig.defaultCategories;
  const topics = propertyTopics.length > 0 ? propertyTopics : currentConfig.defaultTopics;
  const tags = getPropertyStringArray(page.properties?.[currentConfig.tagsProperty]);
  const statusValue = getPropertyString(page.properties?.[currentConfig.statusProperty]);
  const draftValue = getPropertyBoolean(page.properties?.[currentConfig.draftProperty]);
  const draft = Boolean(
    draftValue != null
      ? draftValue
      : currentConfig.syncPublishedOnly
        ? false
        : statusValue && statusValue !== currentConfig.publishedValue,
  );

  const date =
    getPropertyDate(page.properties?.[currentConfig.dateProperty]) ||
    formatDate(page.created_time) ||
    formatDate(page.last_edited_time);

  const frontMatter = buildFrontMatter({
    title,
    date,
    categories,
    topics,
    tags,
    description,
    featureimage: pageCover,
    draft,
    notionPageId: page.id,
  });

  await fs.writeFile(outputPath, `${frontMatter}\n${body}\n`, "utf8");
  managedPosts.byPageId.set(page.id, { outputPath, slug });

  console.log(`[notion-sync] Wrote ${path.relative(repoRoot, outputPath)}`);
}

function pickTitlePropertyName(dataSource, configuredName) {
  if (dataSource?.properties?.[configuredName]?.type === "title") {
    return configuredName;
  }

  for (const [name, definition] of Object.entries(dataSource?.properties || {})) {
    if (definition?.type === "title") {
      return name;
    }
  }

  return configuredName;
}

async function ensureSafeTarget({ pageId, slug, outputPath, assetDir, managedPosts }) {
  const existingForPage = managedPosts.byPageId.get(pageId);
  if (existingForPage && existingForPage.outputPath !== outputPath) {
    await removeManagedOutput(existingForPage.outputPath, existingForPage.slug);
  }

  const existingFileId = await getManagedPageIdFromFile(outputPath);
  if (existingFileId && existingFileId !== pageId) {
    throw new Error(
      `Refusing to overwrite ${path.relative(repoRoot, outputPath)} because it belongs to a different Notion page.`,
    );
  }

  if (!existingFileId && (await pathExists(outputPath))) {
    throw new Error(
      `Refusing to overwrite ${path.relative(repoRoot, outputPath)} because it was not generated by this sync.`,
    );
  }

  const assetDirExists = await pathExists(assetDir);
  if (assetDirExists) {
    if (existingFileId === pageId) {
      await fs.rm(assetDir, { recursive: true, force: true });
    } else {
      throw new Error(
        `Refusing to overwrite ${path.relative(repoRoot, assetDir)} because it may contain manual assets.`,
      );
    }
  }
}

async function removeManagedOutput(outputPath, slug) {
  await fs.rm(outputPath, { force: true });
  await fs.rm(path.join(config.outputDir, `${slug}-img`), {
    recursive: true,
    force: true,
  });
}

async function scanManagedPosts(outputDir) {
  const byPageId = new Map();
  const entries = await fs.readdir(outputDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }

    const filePath = path.join(outputDir, entry.name);
    const pageId = await getManagedPageIdFromFile(filePath);
    if (!pageId) {
      continue;
    }

    byPageId.set(pageId, {
      outputPath: filePath,
      slug: path.basename(entry.name, ".md"),
    });
  }

  return { byPageId };
}

async function getManagedPageIdFromFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const match = raw.match(/(?:^|\n)notion_page_id:\s*"?(?<id>[a-f0-9-]+)"?(?:\n|$)/i);
    return match?.groups?.id || null;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function resolvePageCover(page, assetDir) {
  if (!page.cover) {
    return null;
  }

  return downloadFileObject(page.cover, {
    assetDir,
    baseName: "cover",
    fallbackUrl: getFileObjectUrl(page.cover),
  });
}

async function fetchBlockChildren(blockId) {
  const blocks = [];
  let nextCursor = null;

  do {
    const params = new URLSearchParams();
    params.set("page_size", "100");
    if (nextCursor) {
      params.set("start_cursor", nextCursor);
    }

    const response = await notionRequest(`/v1/blocks/${blockId}/children?${params.toString()}`);
    blocks.push(...(response.results || []));
    nextCursor = response.has_more ? response.next_cursor : null;
  } while (nextCursor);

  return blocks;
}

async function renderBlocks(blocks, ctx, options = {}) {
  const rendered = [];
  let index = 0;

  while (index < blocks.length) {
    const block = blocks[index];

    if (isListBlock(block)) {
      const listGroup = [];
      let currentIndex = index;

      while (currentIndex < blocks.length && isListBlock(blocks[currentIndex])) {
        const markdown = (await renderBlock(blocks[currentIndex], ctx, options)).trimEnd();
        if (markdown) {
          listGroup.push(markdown);
        }
        currentIndex += 1;
      }

      if (listGroup.length > 0) {
        rendered.push({
          markdown: listGroup.join("\n"),
          kind: "list",
        });
      }

      index = currentIndex;
      continue;
    }

    const markdown = (await renderBlock(block, ctx, options)).trimEnd();
    if (markdown) {
      rendered.push({
        markdown,
        kind: block.type,
      });
    }
    index += 1;
  }

  return joinRenderedBlocks(rendered);
}

async function renderBlock(block, ctx, options = {}) {
  const indentLevel = options.indentLevel || 0;
  const indent = "  ".repeat(indentLevel);

  switch (block.type) {
    case "paragraph": {
      const text = richTextArrayToMarkdown(block.paragraph.rich_text);
      return indentBlock(text || "", indent);
    }

    case "heading_1":
      return indentBlock(`# ${richTextArrayToMarkdown(block.heading_1.rich_text)}`, indent);
    case "heading_2":
      return indentBlock(`## ${richTextArrayToMarkdown(block.heading_2.rich_text)}`, indent);
    case "heading_3":
      return indentBlock(`### ${richTextArrayToMarkdown(block.heading_3.rich_text)}`, indent);

    case "bulleted_list_item":
      return renderListItem(block, ctx, {
        indentLevel,
        marker: "-",
        richText: block.bulleted_list_item.rich_text,
      });

    case "numbered_list_item":
      return renderListItem(block, ctx, {
        indentLevel,
        marker: "1.",
        richText: block.numbered_list_item.rich_text,
      });

    case "to_do":
      return renderListItem(block, ctx, {
        indentLevel,
        marker: block.to_do.checked ? "- [x]" : "- [ ]",
        richText: block.to_do.rich_text,
      });

    case "quote": {
      const text = richTextArrayToMarkdown(block.quote.rich_text);
      return indentBlock(
        text
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n"),
        indent,
      );
    }

    case "callout": {
      const icon = block.callout.icon?.type === "emoji" ? `${block.callout.icon.emoji} ` : "";
      const text = `${icon}${richTextArrayToMarkdown(block.callout.rich_text)}`.trim();
      const children = block.has_children
        ? await renderBlocks(await fetchBlockChildren(block.id), ctx, {})
        : "";
      const content = [text, children].filter(Boolean).join("\n\n");
      return indentBlock(
        content
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n"),
        indent,
      );
    }

    case "code": {
      const language = block.code.language || "";
      const code = block.code.rich_text.map((item) => item.plain_text).join("");
      return indentBlock(`\`\`\`${language}\n${code}\n\`\`\``, indent);
    }

    case "divider":
      return indentBlock("---", indent);

    case "image": {
      const caption = richTextArrayToMarkdown(block.image.caption) || "image";
      const localPath = await downloadFileObject(block.image, {
        assetDir: ctx.assetDir,
        baseName: `img${ctx.assetCounter++}`,
        fallbackUrl: getFileObjectUrl(block.image),
      });
      return indentBlock(`![${escapeLinkText(caption)}](${localPath})`, indent);
    }

    case "file":
    case "pdf":
    case "audio":
    case "video": {
      const fileObject = block[block.type];
      const label = richTextArrayToMarkdown(fileObject.caption) || block.type;
      const href =
        (await downloadFileObject(fileObject, {
          assetDir: ctx.assetDir,
          baseName: `${block.type}${ctx.assetCounter++}`,
          fallbackUrl: getFileObjectUrl(fileObject),
          allowFallbackUrl: true,
        })) || getFileObjectUrl(fileObject);
      return href ? indentBlock(`[${escapeLinkText(label)}](${href})`, indent) : "";
    }

    case "bookmark":
      return indentBlock(block.bookmark.url || "", indent);

    case "link_preview":
    case "embed":
      return indentBlock(block[block.type].url || "", indent);

    case "equation":
      return indentBlock(`$$${block.equation.expression}$$`, indent);

    case "toggle": {
      const summary = richTextArrayToMarkdown(block.toggle.rich_text) || "Details";
      const children = block.has_children
        ? await renderBlocks(await fetchBlockChildren(block.id), ctx, {})
        : "";
      return indentBlock(
        `<details>\n<summary>${escapeHtml(summary)}</summary>\n\n${children}\n\n</details>`,
        indent,
      );
    }

    case "table":
      return indentBlock(await renderTable(block), indent);

    case "table_of_contents":
      return indentBlock("<!-- notion: table_of_contents omitted -->", indent);

    default:
      return indentBlock(`<!-- notion: unsupported block type ${block.type} -->`, indent);
  }

  async function renderListItem(listBlock, currentCtx, listOptions) {
    const text = richTextArrayToMarkdown(listOptions.richText).trim() || " ";
    const prefix = `${indent}${listOptions.marker} ${text}`;
    if (!listBlock.has_children) {
      return prefix;
    }

    const children = await renderBlocks(await fetchBlockChildren(listBlock.id), currentCtx, {
      compact: true,
      indentLevel: listOptions.indentLevel + 1,
    });

    return children ? `${prefix}\n${children}` : prefix;
  }
}

async function renderTable(block) {
  const rows = await fetchBlockChildren(block.id);
  if (rows.length === 0) {
    return "";
  }

  const hasColumnHeader = Boolean(block.table?.has_column_header);
  const hasRowHeader = Boolean(block.table?.has_row_header);
  const lines = [];

  lines.push("<table>");

  if (hasColumnHeader) {
    const header = rows[0];
    lines.push("  <thead>");
    lines.push("    <tr>");
    for (const cell of header.table_row.cells) {
      lines.push(`      <th>${escapeHtml(richTextArrayToMarkdown(cell))}</th>`);
    }
    lines.push("    </tr>");
    lines.push("  </thead>");
  }

  lines.push("  <tbody>");
  const bodyRows = hasColumnHeader ? rows.slice(1) : rows;

  for (const row of bodyRows) {
    lines.push("    <tr>");
    row.table_row.cells.forEach((cell, index) => {
      const tag = hasRowHeader && index === 0 ? "th" : "td";
      lines.push(`      <${tag}>${escapeHtml(richTextArrayToMarkdown(cell))}</${tag}>`);
    });
    lines.push("    </tr>");
  }

  lines.push("  </tbody>");
  lines.push("</table>");
  return lines.join("\n");
}

function indentBlock(text, indent) {
  if (!text || !indent) {
    return text;
  }

  return text
    .split("\n")
    .map((line) => (line ? `${indent}${line}` : line))
    .join("\n");
}

function isListBlock(block) {
  return ["bulleted_list_item", "numbered_list_item", "to_do"].includes(block?.type);
}

function joinRenderedBlocks(blocks) {
  if (blocks.length === 0) {
    return "";
  }

  let result = blocks[0].markdown;

  for (let index = 1; index < blocks.length; index += 1) {
    const previous = blocks[index - 1];
    const current = blocks[index];
    const separator = previous.kind === "list" && current.kind === "list" ? "\n" : "\n\n";
    result += `${separator}${current.markdown}`;
  }

  return result;
}

async function downloadFileObject(fileObject, options) {
  const sourceUrl = getFileObjectUrl(fileObject);
  if (!sourceUrl) {
    return options.allowFallbackUrl ? options.fallbackUrl || null : null;
  }

  try {
    const response = await fetch(sourceUrl);
    if (!response.ok) {
      throw new Error(`download failed with ${response.status}`);
    }

    const contentType = response.headers.get("content-type");
    const ext = extensionFromUrl(sourceUrl) || extensionFromContentType(contentType) || ".bin";
    await fs.mkdir(options.assetDir, { recursive: true });

    const filename = `${sanitizeFilename(options.baseName)}${ext}`;
    const destination = path.join(options.assetDir, filename);
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(destination, buffer);

    return `../${path.basename(options.assetDir)}/${filename}`;
  } catch (error) {
    if (options.allowFallbackUrl && options.fallbackUrl) {
      console.warn(`[notion-sync] Falling back to remote URL for ${options.baseName}: ${error.message}`);
      return options.fallbackUrl;
    }

    throw new Error(`Failed to download asset ${sourceUrl}: ${error.message}`);
  }
}

function getFileObjectUrl(fileObject) {
  if (!fileObject) {
    return null;
  }

  if (fileObject.type === "external") {
    return fileObject.external?.url || null;
  }

  if (fileObject.type === "file") {
    return fileObject.file?.url || null;
  }

  return fileObject.url || null;
}

function getPropertyString(property) {
  if (!property) {
    return "";
  }

  switch (property.type) {
    case "title":
    case "rich_text":
      return richTextArrayToMarkdown(property[property.type]).trim();
    case "select":
    case "status":
      return property[property.type]?.name || "";
    case "url":
    case "email":
    case "phone_number":
      return property[property.type] || "";
    case "number":
      return property.number == null ? "" : String(property.number);
    case "checkbox":
      return String(property.checkbox);
    case "date":
      return property.date?.start || "";
    case "formula":
      return getFormulaValue(property.formula);
    case "created_time":
    case "last_edited_time":
      return property[property.type] || "";
    default:
      return "";
  }
}

function getPropertyStringArray(property) {
  if (!property) {
    return [];
  }

  switch (property.type) {
    case "multi_select":
      return property.multi_select.map((item) => item.name).filter(Boolean);
    case "people":
      return property.people.map((person) => person.name).filter(Boolean);
    case "rich_text":
    case "title":
      return splitCsv(richTextArrayToMarkdown(property[property.type]));
    case "formula": {
      const value = getFormulaValue(property.formula);
      return splitCsv(value);
    }
    default:
      return [];
  }
}

function getPropertyBoolean(property) {
  if (!property) {
    return null;
  }

  if (property.type === "checkbox") {
    return property.checkbox;
  }

  if (property.type === "formula" && property.formula?.type === "boolean") {
    return property.formula.boolean;
  }

  return null;
}

function getPropertyDate(property) {
  if (!property) {
    return "";
  }

  if (property.type === "date") {
    return formatDate(property.date?.start);
  }

  if (property.type === "created_time" || property.type === "last_edited_time") {
    return formatDate(property[property.type]);
  }

  if (property.type === "formula" && property.formula?.type === "date") {
    return formatDate(property.formula.date?.start);
  }

  return "";
}

function getFormulaValue(formula) {
  if (!formula) {
    return "";
  }

  switch (formula.type) {
    case "string":
      return formula.string || "";
    case "number":
      return formula.number == null ? "" : String(formula.number);
    case "boolean":
      return String(Boolean(formula.boolean));
    case "date":
      return formula.date?.start || "";
    default:
      return "";
  }
}

function buildFrontMatter(fields) {
  const lines = ["---"];
  lines.push(`title: ${yamlString(fields.title)}`);
  if (fields.date) {
    lines.push(`date: ${fields.date}`);
  }
  if (fields.categories.length > 0) {
    lines.push(`categories: ${yamlArray(fields.categories)}`);
  }
  if (fields.topics.length > 0) {
    lines.push(`topics: ${yamlArray(fields.topics)}`);
  }
  if (fields.tags.length > 0) {
    lines.push(`tags: ${yamlArray(fields.tags)}`);
  }
  if (fields.description) {
    lines.push(`description: ${yamlString(fields.description)}`);
  }
  if (fields.featureimage) {
    lines.push(`featureimage: ${yamlString(fields.featureimage)}`);
  }
  lines.push(`draft: ${fields.draft ? "true" : "false"}`);
  lines.push(`notion_page_id: ${yamlString(fields.notionPageId)}`);
  lines.push("---");
  return lines.join("\n");
}

async function notionRequest(endpoint, options = {}) {
  const response = await fetch(`https://api.notion.com${endpoint}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Notion API ${response.status} for ${endpoint}: ${bodyText}`);
  }

  return response.json();
}

function richTextArrayToMarkdown(richText = []) {
  return richText.map(richTextToMarkdown).join("");
}

function richTextToMarkdown(item) {
  if (!item) {
    return "";
  }

  let content = item.plain_text || "";
  if (item.type === "equation") {
    content = `$${item.equation.expression}$`;
  }

  if (item.annotations?.code) {
    content = wrapInlineCode(content);
  } else {
    if (item.href) {
      content = `[${escapeLinkText(content)}](${item.href})`;
    }
    if (item.annotations?.bold) {
      content = `**${content}**`;
    }
    if (item.annotations?.italic) {
      content = `*${content}*`;
    }
    if (item.annotations?.strikethrough) {
      content = `~~${content}~~`;
    }
  }

  return content;
}

function wrapInlineCode(text) {
  const matches = text.match(/`+/g) || [];
  const maxBackticks = matches.reduce((max, current) => Math.max(max, current.length), 0);
  const fence = "`".repeat(maxBackticks + 1);
  return `${fence}${text}${fence}`;
}

function yamlString(value) {
  return JSON.stringify(value ?? "");
}

function yamlArray(values) {
  return `[${values.map((value) => yamlString(value)).join(", ")}]`;
}

function parseBoolean(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function splitCsv(value) {
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/['"`]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function sanitizeFilename(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function extensionFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname);
    return ext && ext.length <= 6 ? ext.toLowerCase() : "";
  } catch {
    return "";
  }
}

function extensionFromContentType(contentType) {
  const normalized = String(contentType || "").split(";")[0].trim().toLowerCase();
  const mapping = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "image/avif": ".avif",
    "application/pdf": ".pdf",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "video/mp4": ".mp4",
  };
  return mapping[normalized] || "";
}

function formatDate(value) {
  if (!value) {
    return "";
  }

  const stringValue = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(stringValue)) {
    return stringValue;
  }

  const parsed = new Date(stringValue);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  return parsed.toISOString().slice(0, 10);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeLinkText(value) {
  return String(value).replaceAll("[", "\\[").replaceAll("]", "\\]");
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
