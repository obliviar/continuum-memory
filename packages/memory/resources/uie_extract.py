"""Shared local UIE-base bridge. Supports one-shot and line-delimited stdio."""

import argparse
import json
import sys


SCHEMA = [
    "人物", "地点", "组织机构", "项目", "企业", "影视作品", "图书作品",
    "歌曲", "历史人物", "学校", "国家", "行政区",
    "姓名", "职业", "所在地", "喜好", "当前项目",
    "课程", "上课地点", "爱好", "喜欢",
    {"人物": ["父亲", "母亲", "丈夫", "妻子", "国籍", "毕业院校", "居住地", "所属组织"]},
    {"影视作品": ["主演", "导演", "出品公司", "上映时间", "票房", "主题曲"]},
    {"图书作品": ["作者"]},
    {"歌曲": ["歌手", "作词", "作曲", "所属专辑"]},
    {"历史人物": ["朝代"]},
    {"企业": ["董事长", "创始人", "总部地点"]},
    {"机构": ["成立日期"]},
    {"学校": ["校长"]},
    {"国家": ["官方语言"]},
    {"行政区": ["人口数量"]},
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--serve", action="store_true")
    location = parser.add_mutually_exclusive_group(required=True)
    location.add_argument("--home-path")
    location.add_argument("--model-path")
    args = parser.parse_args()
    from paddlenlp import Taskflow

    model_location = {"task_path": args.model_path} if args.model_path else {"home_path": args.home_path}
    extractor = Taskflow(
        "information_extraction",
        schema=SCHEMA,
        model="uie-base",
        **model_location,
        batch_size=8,
    )
    def extract(request):
        text = request.get("text")
        if not isinstance(text, str) or not text.strip() or len(text) > 4000:
            raise ValueError("text must contain 1–4000 characters")
        schema = request.get("schema", SCHEMA)
        if not isinstance(schema, list) or not 1 <= len(schema) <= 64:
            raise ValueError("schema must contain 1–64 extraction targets")
        count = 0
        for target in schema:
            if isinstance(target, str):
                labels = [target]
            elif isinstance(target, dict) and len(target) == 1:
                label, children = next(iter(target.items()))
                if not isinstance(children, list) or not 1 <= len(children) <= 32:
                    raise ValueError("relation targets must contain 1–32 labels")
                labels = [label] + children
            else:
                raise ValueError("invalid extraction target")
            if any(not isinstance(label, str) or not label.strip() or len(label) > 100 for label in labels):
                raise ValueError("invalid extraction label")
            count += len(labels)
        if count > 128:
            raise ValueError("too many extraction labels")
        # Reset on every request so a custom schema cannot affect the next default request.
        extractor.set_schema(schema)
        result = extractor(text)
        if not isinstance(result, list) or len(result) != 1:
            raise ValueError("UIE returned an unexpected number of results")
        return result[0]

    if args.serve:
        for line in sys.stdin:
            try:
                response = {"ok": True, "result": extract(json.loads(line))}
            except Exception as error:
                response = {"ok": False, "error": str(error)[:500]}
            sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
            sys.stdout.flush()
    else:
        sys.stdout.write(json.dumps(extract(json.load(sys.stdin)), ensure_ascii=False, separators=(",", ":")))
        sys.stdout.flush()


if __name__ == "__main__":
    main()
