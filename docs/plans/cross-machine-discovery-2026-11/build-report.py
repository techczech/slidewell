#!/usr/bin/env python3
"""Compile canonical Markdown and isolated mockup assets into one offline HTML report."""
from pathlib import Path
import html
import re
import sys
import markdown

ROOT = Path(__file__).resolve().parent


def body(path):
    text = path.read_text(encoding='utf-8')
    if text.startswith('---\n'):
        text = text.split('\n---\n', 1)[1]
    return text


def render(name):
    source = ROOT / (name + '.md')
    parts = re.split(r'(?m)(?=^## )', body(source))
    output = []
    for part in parts:
        heading = re.search(r'(?m)^## (.+)', part)
        slug = re.sub(r'[^a-z0-9 -]', '', heading[1].lower()).replace(' ', '-') if heading else ''
        ref = name + '.md' + ('#' + slug if slug else '')
        chunk = markdown.markdown(part, extensions=['tables', 'fenced_code', 'sane_lists', 'toc'])
        def stamp(match):
            tag = match[0]
            return tag if 'data-source-ref=' in tag else tag[:-1] + ' data-source-ref="' + html.escape(ref, quote=True) + '">'
        chunk = re.sub(r'<(?:p|h[1-6]|th|td|button|a|label|span|strong)\b[^>]*>', stamp, chunk)
        output.append(chunk)
    return '\n'.join(output)


def build():
    content = render('report')
    for name in ['scores', 'direction-a', 'direction-b', 'direction-c', 'verification']:
        marker = '<!-- include:' + name + ' -->'
        if marker not in content:
            raise ValueError('Missing include: ' + name)
        content = content.replace(marker, render(name))
    if '<!-- include:' in content:
        raise ValueError('Unresolved include')
    css = '\n'.join((ROOT / name).read_text() for name in ['report.css', 'direction-a.css', 'direction-b.css', 'direction-c.css'])
    js = '\n'.join((ROOT / name).read_text() for name in ['direction-a.js', 'direction-b.js', 'direction-c.js'])
    # All visible copy is compiled from Markdown; the shell only provides document mechanics.
    source = (ROOT / 'report.md').read_text()
    title = next(line.removeprefix('title: ').strip() for line in source.splitlines() if line.startswith('title: '))
    page = '<!doctype html>\n<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    page += '<meta name="color-scheme" content="light dark"><title>' + html.escape(title) + '</title><style>' + css + '</style></head>'
    page += '<body><main class="report-body">' + content + '</main><script>' + js.replace('</script', '<\\/script') + '</script></body></html>\n'
    target = ROOT / 'report.html'
    target.write_text(page, encoding='utf-8')
    return target


if __name__ == '__main__':
    result = build()
    print(str(result) + ' (' + str(result.stat().st_size) + ' bytes)')
