from __future__ import annotations

import html
import re
import zipfile
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
SOURCE = BASE_DIR / "api-interface-paper.html"
OUTPUT = BASE_DIR / "前后端分离的API接口调试与文档管理系统设计与实现-降重版.docx"


class PaperParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.in_body = False
        self.skip = 0
        self.block_stack: list[dict[str, str]] = []
        self.current_text: list[str] = []
        self.elements: list[dict[str, object]] = []
        self.context: list[str] = []
        self.table: list[list[str]] | None = None
        self.row: list[str] | None = None
        self.cell_text: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_dict = {k: v or "" for k, v in attrs}
        cls = attrs_dict.get("class", "")
        if tag == "body":
            self.in_body = True
            return
        if not self.in_body:
            return
        if tag in {"style", "script"}:
            self.skip += 1
            return
        if self.skip:
            return
        if tag == "section":
            self.context.append(cls)
            return
        if tag == "table":
            self.table = []
            return
        if self.table is not None:
            if tag == "tr":
                self.row = []
            elif tag in {"td", "th"}:
                self.cell_text = []
            return
        if tag in {"h1", "h2", "h3", "p"}:
            self._start_block(tag, cls)
            return
        if tag == "div":
            if cls in {"abstract-title", "date"} or "meta" in self.context:
                self._start_block("div", cls)
            elif cls:
                self.context.append(cls)
            return
        if tag == "br" and self.current_text is not None:
            self.current_text.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag == "body":
            self.in_body = False
            return
        if not self.in_body:
            return
        if tag in {"style", "script"} and self.skip:
            self.skip -= 1
            return
        if self.skip:
            return
        if self.table is not None:
            if tag in {"td", "th"} and self.cell_text is not None and self.row is not None:
                self.row.append(self._clean("".join(self.cell_text)))
                self.cell_text = None
            elif tag == "tr" and self.row is not None:
                self.table.append(self.row)
                self.row = None
            elif tag == "table":
                self.elements.append({"type": "table", "rows": self.table})
                self.table = None
            return
        if tag in {"h1", "h2", "h3", "p", "div"} and self.block_stack:
            block = self.block_stack.pop()
            text = self._clean("".join(self.current_text))
            self.current_text = []
            if text:
                block["text"] = text
                self.elements.append(block)
            return
        if tag == "section" and self.context:
            self.context.pop()

    def handle_data(self, data: str) -> None:
        if not self.in_body or self.skip:
            return
        if self.cell_text is not None:
            self.cell_text.append(data)
        elif self.block_stack:
            self.current_text.append(data)

    def _start_block(self, tag: str, cls: str) -> None:
        self.block_stack.append({"type": tag, "class": cls, "context": " ".join(self.context)})
        self.current_text = []

    @staticmethod
    def _clean(value: str) -> str:
        value = value.replace("\xa0", " ")
        value = re.sub(r"[ \t\r\n]+", " ", value)
        return value.strip()


def xml_escape(value: str) -> str:
    return html.escape(value, quote=False)


def run_xml(text: str, *, bold: bool = False, size: int = 24, font: str = "宋体") -> str:
    if not text:
        return ""
    rpr = [
        f'<w:rFonts w:ascii="{font}" w:hAnsi="{font}" w:eastAsia="{font}"/>',
        f'<w:sz w:val="{size}"/>',
        f'<w:szCs w:val="{size}"/>',
    ]
    if bold:
        rpr.append("<w:b/>")
    lines = text.split("\n")
    parts: list[str] = []
    for idx, line in enumerate(lines):
        if idx:
            parts.append("<w:br/>")
        parts.append(f'<w:t xml:space="preserve">{xml_escape(line)}</w:t>')
    return f"<w:r><w:rPr>{''.join(rpr)}</w:rPr>{''.join(parts)}</w:r>"


def para_xml(
    text: str = "",
    *,
    align: str | None = None,
    bold: bool = False,
    size: int = 24,
    indent: bool = False,
    page_break_before: bool = False,
    page_break_after: bool = False,
) -> str:
    ppr: list[str] = []
    if align:
        ppr.append(f'<w:jc w:val="{align}"/>')
    if indent:
        ppr.append('<w:ind w:firstLineChars="200"/>')
    ppr.append('<w:spacing w:line="300" w:lineRule="auto"/>')
    before = '<w:r><w:br w:type="page"/></w:r>' if page_break_before else ""
    after = '<w:r><w:br w:type="page"/></w:r>' if page_break_after else ""
    return f"<w:p><w:pPr>{''.join(ppr)}</w:pPr>{before}{run_xml(text, bold=bold, size=size)}{after}</w:p>"


def table_xml(rows: list[list[str]]) -> str:
    grid = ""
    max_cols = max((len(row) for row in rows), default=0)
    if max_cols:
        grid = "<w:tblGrid>" + "".join('<w:gridCol w:w="2400"/>' for _ in range(max_cols)) + "</w:tblGrid>"
    tbl_pr = (
        "<w:tblPr>"
        '<w:tblW w:w="0" w:type="auto"/>'
        '<w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="000000"/>'
        '<w:left w:val="single" w:sz="4" w:space="0" w:color="000000"/>'
        '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="000000"/>'
        '<w:right w:val="single" w:sz="4" w:space="0" w:color="000000"/>'
        '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="000000"/>'
        '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="000000"/></w:tblBorders>'
        "</w:tblPr>"
    )
    tr_xml: list[str] = []
    for row_index, row in enumerate(rows):
        tc_xml: list[str] = []
        for cell in row:
            tc_pr = '<w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>'
            tc_xml.append(f"<w:tc>{tc_pr}{para_xml(cell, align='center' if row_index == 0 else None, bold=row_index == 0, size=21)}</w:tc>")
        tr_xml.append(f"<w:tr>{''.join(tc_xml)}</w:tr>")
    return f"<w:tbl>{tbl_pr}{grid}{''.join(tr_xml)}</w:tbl>"


def build_document(elements: list[dict[str, object]]) -> str:
    body_parts: list[str] = []
    pending_toc_break = False
    for element in elements:
        if element["type"] == "table":
            body_parts.append(table_xml(element["rows"]))  # type: ignore[arg-type]
            continue

        text = str(element.get("text", ""))
        tag = str(element["type"])
        cls = str(element.get("class", ""))
        context = str(element.get("context", ""))

        page_before = False
        page_after = False
        align: str | None = None
        bold = False
        size = 24
        indent = False

        if text == "Abstract":
            page_before = True
            align = "center"
            bold = True
            size = 32
        elif text == "目 录":
            page_before = True
            align = "center"
            bold = True
            size = 32
            pending_toc_break = True
        elif text == "1 引言" and pending_toc_break:
            page_before = True
            align = "center"
            bold = True
            size = 32
        elif tag == "h1":
            align = "center"
            bold = True
            size = 32 if text not in {"本科生毕业论文"} else 36
        elif tag == "h2":
            if "cover" in context:
                align = "center"
                bold = True
                size = 36
            else:
                bold = True
                size = 24
        elif cls == "abstract-title":
            align = "center"
            bold = True
            size = 32
        elif cls == "date":
            align = "center"
            size = 28
            page_after = True
        elif cls == "center":
            align = "center"
        elif cls == "keyword" or "toc" in context:
            indent = False
        elif "meta" in context:
            size = 28
        else:
            indent = tag == "p"

        if text == "前后端分离的API接口调试与文档管理系统设计与实现" and "cover" in context:
            align = "center"
            bold = True
            size = 44

        body_parts.append(
            para_xml(
                text,
                align=align,
                bold=bold,
                size=size,
                indent=indent,
                page_break_before=page_before,
                page_break_after=page_after,
            )
        )

    sect_pr = (
        "<w:sectPr>"
        '<w:pgSz w:w="11906" w:h="16838"/>'
        '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/>'
        "</w:sectPr>"
    )
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body>{''.join(body_parts)}{sect_pr}</w:body></w:document>"
    )


def content_types_xml() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
        "</Types>"
    )


def rels_xml() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
        "</Relationships>"
    )


def core_xml() -> str:
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/" '
        'xmlns:dcterms="http://purl.org/dc/terms/" '
        'xmlns:dcmitype="http://purl.org/dc/dcmitype/" '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        "<dc:title>前后端分离的API接口调试与文档管理系统设计与实现</dc:title>"
        "<dc:creator>Codex</dc:creator>"
        f'<dcterms:created xsi:type="dcterms:W3CDTF">{now}</dcterms:created>'
        f'<dcterms:modified xsi:type="dcterms:W3CDTF">{now}</dcterms:modified>'
        "</cp:coreProperties>"
    )


def app_xml() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
        'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
        "<Application>Microsoft Word</Application>"
        "</Properties>"
    )


def main() -> None:
    parser = PaperParser()
    parser.feed(SOURCE.read_text(encoding="utf-8"))
    document = build_document(parser.elements)
    with zipfile.ZipFile(OUTPUT, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", content_types_xml())
        zf.writestr("_rels/.rels", rels_xml())
        zf.writestr("word/document.xml", document)
        zf.writestr("docProps/core.xml", core_xml())
        zf.writestr("docProps/app.xml", app_xml())
    print(OUTPUT)
    print(f"elements={len(parser.elements)}")


if __name__ == "__main__":
    main()
