import fs from "fs/promises";
import path from "path";

async function main() {
  const mupdf = await import("mupdf");

  async function renderSheetPng(pdfPath, maxPx = 2000) {
    let doc;
    let page;
    try {
      const buf = await fs.readFile(pdfPath);
      doc = mupdf.Document.openDocument(buf, "application/pdf");
      page = doc.loadPage(0);
      const b = page.getBounds();
      const longEdge = Math.max(b[2] - b[0], b[3] - b[1]);
      if (!longEdge) return null;
      const zoom = Math.min(maxPx / longEdge, 4);
      const pix = page.toPixmap(mupdf.Matrix.scale(zoom, zoom), mupdf.ColorSpace.DeviceRGB, false);
      const png = Buffer.from(pix.asPNG());
      pix.destroy();
      return png;
    } finally {
      try {
        page?.destroy();
      } catch {}
      try {
        doc?.destroy();
      } catch {}
    }
  }

  const root = path.join(process.cwd(), "data/demo/los-angeles-1");
  const plansDir = path.join(root, "plans");
  const viewerDir = path.join(root, "viewer");
  await fs.mkdir(viewerDir, { recursive: true });

  const files = (await fs.readdir(plansDir))
    .filter((f) => f.endsWith(".pdf"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const sheets = [];
  for (const file of files.slice(0, 12)) {
    const png = await renderSheetPng(path.join(plansDir, file));
    if (png) {
      await fs.writeFile(path.join(viewerDir, `${sheets.length}.png`), png);
      sheets.push({ name: file.replace(/\.pdf$/i, "") });
      console.log("rendered", file);
    }
  }

  await fs.writeFile(
    path.join(viewerDir, "meta.json"),
    JSON.stringify({ status: "ready", sheets })
  );
  console.log("done", sheets.length, "sheets");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
