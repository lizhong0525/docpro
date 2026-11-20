"""Assemble four independent, portable course submissions using a file allowlist."""

import argparse
from pathlib import Path
from tempfile import NamedTemporaryFile
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "提交包"
TITLES = dict(zip(("01", "02", "03", "04"), ("静态网页", "CSS排版", "JS交互", "网站设计")))
PROMPTS = {"01": "HTML", "02": "CSS", "03": "JS", "04": "编辑器"}
STAGES = {
    "01": ("01-html", ("index.html", "about.html")),
    "02": ("02-css", ("index.html", "styles.css")),
    "03": ("03-js", ("index.html", "styles.css", "review.js")),
}
EDITOR_CONFIG = (
    ".env.example", ".gitignore", "index.html", "package.json", "pnpm-lock.yaml",
    "pnpm-workspace.yaml", "playwright.config.ts", "vitest.config.ts", "vite.config.ts",
    "tsconfig.json", "tsconfig.server.json",
)


def contents(number):
    stem = f"学号_姓名_网页设计_{TITLES[number]}"
    files = {}

    def add(relative, member=None):
        source = ROOT / relative
        if not source.is_file() or not source.resolve().is_relative_to(ROOT):
            raise FileNotFoundError(relative)
        files[member or relative] = source

    def add_matching(folder, extensions):
        paths = sorted(path for path in (ROOT / folder).rglob("*")
                       if path.is_file() and path.suffix.lower() in extensions)
        if not paths:
            raise FileNotFoundError(folder)
        for path in paths:
            add(path.relative_to(ROOT).as_posix())

    if number in STAGES:
        stage, names = STAGES[number]
        for name in names:
            add(f"stages/{stage}/{name}", name)
        return stem, files

    for ext in ("pdf", "docx"):
        add(f"reports/{stem}.{ext}")
    add_matching(f"evidence/shots/{number}", {".png"})
    for relative in ("README.md", "index.html", "启动编辑器.cmd", "tools/launch.mjs",
                     "runtime/node.exe", "runtime/NODE-LICENSE.txt"):
        add(relative)
    for index, (stage, names) in STAGES.items():
        for name in names:
            add(f"stages/{stage}/{name}")
            add(f"evidence/initial/{index}/{name}")
        for ext in ("pdf", "docx"):
            add(f"reports/学号_姓名_网页设计_{TITLES[index]}.{ext}")
        add_matching(f"evidence/shots/{index}", {".png"})
    for stage, topic in PROMPTS.items():
        add(f"prompts/{stage}-{topic}.md")
    for name in EDITOR_CONFIG:
        add("editor/" + name)
    if (ROOT / "editor/README.md").is_file():
        add("editor/README.md")
    for folder in ("src", "server", "e2e", "tests", "scripts"):
        add_matching(f"editor/{folder}", {".ts", ".tsx", ".css", ".mjs", ".js", ".json", ".md", ".docx"})
    add("editor/dist/index.html")
    add_matching("editor/dist", {".html", ".js", ".css", ".woff", ".woff2", ".svg", ".png", ".ico", ".txt"})
    add("editor/runtime/server.mjs")
    add_matching("editor/runtime", {".mjs", ".cjs", ".js", ".json", ".txt", ".wasm", ".node"})
    add_matching("evidence/initial/04", {".ts", ".tsx", ".css", ".json", ".txt"})
    for folder in ("runtime", "editor/runtime", "editor/dist", "editor"):
        for notice in (ROOT / folder).glob("*"):
            if notice.is_file() and notice.name.lower().startswith(
                    ("license", "licence", "third-party", "third_party", "thirdparty", "notice", "copying")):
                add(notice.relative_to(ROOT).as_posix())
    for note in ("stages.md", "editor.md", "04-after-response.txt", "04-browser-tests.txt",
                 "editor-tests.txt", "editor-build.txt"):
        add(f"evidence/notes/{note}")
    return stem, files


def build(number):
    stem, files = contents(number)
    OUTPUT.mkdir(exist_ok=True)
    target = OUTPUT / (stem + ".zip")
    with NamedTemporaryFile(dir=OUTPUT, suffix=".partial", delete=False) as tmp:
        temporary = Path(tmp.name)
    try:
        with ZipFile(temporary, "w", compression=ZIP_DEFLATED, compresslevel=6) as archive:
            for name, path in sorted(files.items()):
                archive.write(path, name)
        with ZipFile(temporary) as archive:
            bad = archive.testzip()
            if bad or set(archive.namelist()) != set(files):
                raise ValueError(f"归档校验未通过：{bad or '文件清单不一致'}")
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"{target.name}　{len(files)} 个文件　{target.stat().st_size:,} 字节")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("numbers", nargs="*", metavar="01..04")
    selected = parser.parse_args().numbers or list(TITLES)
    for number in selected:
        if number not in TITLES:
            parser.error(f"未知作业编号 {number}")
        build(number)
