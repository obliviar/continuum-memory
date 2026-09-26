"""One-shot, local-only UIE-base bridge. JSON in and JSON out on stdio."""

import argparse
import json
import sys


SCHEMA = [
    "人物", "地点", "组织机构", "项目", "企业", "影视作品", "图书作品",
    "歌曲", "历史人物", "学校", "国家", "行政区",
    "姓名", "职业", "所在地", "喜好", "当前项目",
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
    parser.add_argument("--home-path", required=True)
    args = parser.parse_args()
    request = json.load(sys.stdin)
    text = request.get("text")
    if not isinstance(text, str) or not text.strip() or len(text) > 4000:
        raise ValueError("text must contain 1–4000 characters")

    from paddlenlp import Taskflow

    extractor = Taskflow(
        "information_extraction",
        schema=SCHEMA,
        model="uie-base",
        home_path=args.home_path,
        batch_size=8,
    )
    result = extractor(text)
    if not isinstance(result, list) or len(result) != 1:
        raise ValueError("UIE returned an unexpected number of results")
    sys.stdout.write(json.dumps(result[0], ensure_ascii=False, separators=(",", ":")))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
