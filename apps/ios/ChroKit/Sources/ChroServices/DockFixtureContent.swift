import CoreGraphics
import CoreText
import Foundation

/// File contents of the mock's captures (index.html constants of the same names).
extension DockFixtureCheckouts {
    enum Content {
        static let stockTS: [String] = [
            "export interface Item { sku: string; qty: number }",
            "",
            "export function restock(items: Item[], sku: string, amount: number): Item[] {",
            "  return items.map((i) => (i.sku === sku ? { ...i, qty: i.qty + amount } : i));",
            "}",
            "",
            "export function removeStock(items: Item[], sku: string, amount: number): Item[] {",
            "  if (!Number.isFinite(amount) || amount < 0) {",
            "    throw new RangeError(`amount must be a finite non-negative number: ${amount}`);",
            "  }",
            "  return items.map((i) => (i.sku === sku ? { ...i, qty: Math.max(0, i.qty - amount) } : i));",
            "}",
            "",
        ]
        static let stockTestTS: [String] = [
            "import assert from \"node:assert\";",
            "import { removeStock } from \"./stock\";",
            "",
            "const items = [",
            "  { sku: \"A1\", qty: 5 },",
            "  { sku: \"B2\", qty: 1 },",
            "];",
            "",
            "// decrements the matching SKU",
            "assert.deepStrictEqual(removeStock(items, \"A1\", 2), [",
            "  { sku: \"A1\", qty: 3 },",
            "  { sku: \"B2\", qty: 1 },",
            "]);",
            "",
            "// never goes below 0",
            "assert.deepStrictEqual(removeStock(items, \"B2\", 4), [",
            "  { sku: \"A1\", qty: 5 },",
            "  { sku: \"B2\", qty: 0 },",
            "]);",
            "",
            "// leaves other SKUs untouched",
            "assert.strictEqual(",
            "  removeStock(items, \"A1\", 1).find((i) => i.sku === \"B2\")?.qty,",
            "  1,",
            ");",
            "",
            "console.log(\"stock tests passed\");",
        ]
        static let readmeOld: [String] = [
            "# inventory-service",
            "",
            "Stock helpers.",
            "",
            "- `restock(items, sku, amount)` adds to one SKU.",
        ]
        static let readmeNew: [String] = [
            "# inventory-service",
            "",
            "Stock helpers.",
            "",
            "- `restock(items, sku, amount)` adds to one SKU.",
            "- `removeStock(items, sku, amount)` subtracts, never below 0.",
        ]
        static let stockTSMain: [String] = [
            "export type Stock = Record<string, number>;",
            "",
            "export function addStock(stock: Stock, sku: string, qty: number): Stock {",
            "  if (qty <= 0) throw new Error(\"qty must be positive\");",
            "  return { ...stock, [sku]: (stock[sku] ?? 0) + qty };",
            "}",
            "",
            "export function stockLevel(stock: Stock, sku: string): number {",
            "  return stock[sku] ?? 0;",
            "}",
            "",
        ]
        static let readmeMain: [String] = [
            "# inventory-service",
            "",
            "Tracks on-hand and reserved stock for every SKU.",
            "",
            "## Usage",
            "",
            "- `addStock(stock, sku, qty)` adds units.",
            "- `stockLevel(stock, sku)` reads the current level.",
        ]
        static let readmeReworded: [String] = [
            "# inventory-service",
            "",
            "Tracks stock levels per SKU.",
            "",
            "## Usage",
            "",
            "- `addStock(stock, sku, qty)` adds units.",
            "- `stockLevel(stock, sku)` reads the current level.",
        ]
        static let readmeRewordedNew: [String] = [
            "# inventory-service",
            "",
            "Tracks per-SKU stock levels for the warehouse API.",
            "",
            "## Usage",
            "",
            "- `addStock(stock, sku, qty)` adds units.",
            "- `stockLevel(stock, sku)` reads the current level.",
        ]
        static let readmeConflict: [String] = [
            "# inventory-service",
            "",
            "<<<<<<< HEAD",
            "Tracks on-hand and reserved stock for every SKU.",
            "=======",
            "Tracks per-SKU stock levels for the warehouse API.",
            ">>>>>>> 987746a (Auto-commit changes from task run c4534455-915e-44de-9bc3-21b54897febf)",
            "",
            "## Usage",
            "",
            "- `addStock(stock, sku, qty)` adds units.",
            "- `stockLevel(stock, sku)` reads the current level.",
        ]
        static let skillMD: [String] = [
            "---",
            "name: restock-check",
            "description: Check which SKUs fall below their reorder point and draft a restock list. Use when asked about low stock or restocking.",
            "---",
            "# Restock check",
            "",
            "1. Read `src/stock.ts` for the current stock helpers.",
            "2. List every SKU whose level is below its reorder point.",
            "3. Write the list to `docs/restock.md`, one SKU per line with the shortfall.",
        ]

        /// The main checkout of the second capture. Everything under `docs/` is hand-made.
        static let mainFiles: [String: [String]] = [
            ".claude/skills/restock-check/SKILL.md": skillMD,
            "README.md": readmeMain,
            "src/stock.ts": stockTSMain,
            "docs/restock-notes.md": [
                "---",
                "owner: warehouse",
                "reviewed: false",
                "tags: [restock]",
                "---",
                "# Restock notes",
                "",
                "- [ ] Confirm reorder points with [[README]]",
                "- [x] Draft the low-stock list",
                "- Supplier form: https://example.com/reorder-form",
            ],
            // A small report page for the HTML preview: a stylesheet, an image and a
            // script beside it, a link to a note of the checkout and one to the web.
            // The script writes which of the three loaded, so the preview shows it.
            "docs/report/index.html": [
                "<!doctype html>",
                "<html lang=\"en\">",
                "<head>",
                "<meta charset=\"utf-8\">",
                "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
                "<title>Stock report</title>",
                "<link rel=\"stylesheet\" href=\"report.css\">",
                "</head>",
                "<body>",
                "<h1>Stock report</h1>",
                "<p>On hand by SKU: A1 5, B2 1, C3 12.</p>",
                "<img src=\"heatmap.png\" alt=\"SKU heatmap\">",
                "<p id=\"checks\">Checking resources</p>",
                "<p><a href=\"../restock-notes.md\">Restock notes</a> <a href=\"https://example.com/reorder-form\">Supplier form</a></p>",
                "<script src=\"report.js\"></script>",
                "</body>",
                "</html>",
            ],
            "docs/report/report.css": [
                "body { font: 16px/1.5 -apple-system, system-ui, sans-serif; margin: 16px; color: #17181b; }",
                "h1 { color: #0c6cbe; font-size: 22px; margin: 0 0 8px; }",
                "img { width: 128px; height: 128px; image-rendering: pixelated; border-radius: 6px; }",
                "a { margin-right: 16px; }",
            ],
            "docs/report/report.js": [
                "// Reports which of the page's resources loaded.",
                "(function () {",
                "  var image = document.querySelector(\"img\");",
                "  var styled = getComputedStyle(document.querySelector(\"h1\")).color === \"rgb(12, 108, 190)\";",
                "  function report() {",
                "    var loaded = image.complete && image.naturalWidth > 0;",
                "    document.getElementById(\"checks\").textContent =",
                "      \"Script ran. Stylesheet \" + (styled ? \"applied\" : \"missing\") + \". Image \" + (loaded ? \"loaded\" : \"missing\") + \".\";",
                "  }",
                "  if (image.complete) report();",
                "  else { image.addEventListener(\"load\", report); image.addEventListener(\"error\", report); }",
                "})();",
            ],
            "docs/stock-levels.csv": [
                "sku,on_hand,reserved,reorder_point",
                "A1,5,1,4",
                "B2,1,0,3",
                "C3,12,4,6",
            ],
            "docs/skus/A1.md": [
                "---",
                "on_hand: 5",
                "reorder_point: 4",
                "status: ok",
                "reviewed: true",
                "---",
                "# A1",
            ],
            "docs/skus/B2.md": [
                "---",
                "on_hand: 1",
                "reorder_point: 3",
                "status: low",
                "reviewed: false",
                "---",
                "# B2",
            ],
            "docs/skus/C3.md": [
                "---",
                "on_hand: 12",
                "reorder_point: 6",
                "status: ok",
                "reviewed: false",
                "---",
                "# C3",
            ],
            // The mock wrote this file as a sketch (`source:`, `filters: [status is low]`); the fixture
            // states the same two views as a real definition, in JSON (which YAML readers accept).
            "docs/reorder.cbase": [
                "{",
                "  \"version\": 1,",
                "  \"name\": \"reorder\",",
                "  \"dataset\": { \"include\": [\"docs/skus/*.md\"] },",
                "  \"properties\": {",
                "    \"name\": { \"key\": \"file.name\", \"type\": \"text\" },",
                "    \"on_hand\": { \"key\": \"on_hand\", \"type\": \"number\" },",
                "    \"reorder_point\": { \"key\": \"reorder_point\", \"type\": \"number\" },",
                "    \"status\": { \"key\": \"status\", \"type\": \"select\", \"options\": [\"ok\", \"low\"] },",
                "    \"reviewed\": { \"key\": \"reviewed\", \"type\": \"checkbox\" }",
                "  },",
                "  \"views\": [",
                "    { \"id\": \"all-skus\", \"name\": \"All SKUs\", \"type\": \"table\",",
                "      \"table\": { \"columns\": [\"name\", \"on_hand\", \"reorder_point\", \"status\", \"reviewed\"] } },",
                "    { \"id\": \"low-stock\", \"name\": \"Low stock\", \"type\": \"table\",",
                "      \"filters\": [{ \"property\": \"status\", \"op\": \"=\", \"value\": \"low\" }],",
                "      \"table\": { \"columns\": [\"name\", \"on_hand\", \"reorder_point\", \"status\", \"reviewed\"] } }",
                "  ]",
                "}",
            ],
        ]

        /// Hand-made: the pages the mock draws for docs/stock-report.pdf.
        static let stockReportPages: [[String]] = [
            ["Stock report","On hand by SKU: A1 5, B2 1, C3 12.","Reserved: A1 1, C3 4."],
            ["Reorder points","A1 4 · B2 3 · C3 6","B2 is below its reorder point."],
        ]

        /// Hand-made: docs/stock-report.pdf, one page per entry of `stockReportPages` (a heading, then
        /// paragraphs), laid out like the mock's `.pdf-page` cards (300×388 pt, 15 pt heading, 11 pt text).
        static let stockReportPDF: Data = {
            let data = NSMutableData()
            var box = CGRect(x: 0, y: 0, width: 300, height: 388)
            guard let consumer = CGDataConsumer(data: data as CFMutableData),
                  let context = CGContext(consumer: consumer, mediaBox: &box, nil) else { return Data() }
            for page in stockReportPages {
                context.beginPDFPage(nil)
                var y: CGFloat = box.height - 28 - 15
                for (index, text) in page.enumerated() {
                    let font = CTFontCreateWithName((index == 0 ? "Helvetica-Bold" : "Helvetica") as CFString, index == 0 ? 15 : 11, nil)
                    let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [
                        NSAttributedString.Key(kCTFontAttributeName as String): font,
                    ]))
                    context.textPosition = CGPoint(x: 26, y: y)
                    CTLineDraw(line, context)
                    y -= index == 0 ? 25 : 16.5
                }
                context.endPDFPage()
            }
            context.closePDF()
            return data as Data
        }()

        /// Hand-made: docs/warehouse-layout.excalidraw, the scene the mock draws as an SVG
        /// (two shelves, a path to the dock), as a drawing-scene JSON document.
        static let warehouseLayoutScene: String = """
        {
          "type": "excalidraw",
          "version": 2,
          "source": "chro",
          "elements": [
            {"id": "shelf-a", "type": "rectangle", "x": 20, "y": 30, "width": 110, "height": 70, "strokeColor": "#1e1e1e", "backgroundColor": "transparent", "strokeWidth": 2, "roundness": {"type": 3}},
            {"id": "shelf-a-label", "type": "text", "x": 40, "y": 58, "width": 60, "height": 18, "text": "Shelf A", "fontSize": 14, "fontFamily": 1, "strokeColor": "#1e1e1e"},
            {"id": "shelf-b", "type": "rectangle", "x": 170, "y": 30, "width": 110, "height": 70, "strokeColor": "#1e1e1e", "backgroundColor": "transparent", "strokeWidth": 2, "roundness": {"type": 3}},
            {"id": "shelf-b-label", "type": "text", "x": 190, "y": 58, "width": 60, "height": 18, "text": "Shelf B", "fontSize": 14, "fontFamily": 1, "strokeColor": "#1e1e1e"},
            {"id": "route", "type": "line", "x": 75, "y": 100, "width": 150, "height": 50, "strokeColor": "#1971c2", "backgroundColor": "transparent", "strokeWidth": 2, "points": [[0, 0], [0, 50], [150, 50], [150, 0]]},
            {"id": "dock-label", "type": "text", "x": 118, "y": 160, "width": 40, "height": 18, "text": "Dock", "fontSize": 14, "fontFamily": 1, "strokeColor": "#1971c2"}
          ],
          "appState": {"viewBackgroundColor": "#ffffff"},
          "files": {}
        }
        """
    }
}
