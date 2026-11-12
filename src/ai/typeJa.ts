// 型の名前を、行の説明で「string（文字列）」「int（整数）」のように書くための表。
// 表にない名前（自分で作ったクラスなど）は「Point 型」のように書く
export type TypeLang = "python" | "js" | "c" | "go" | "ruby" | "shell" | "other";

const BASE: Record<string, string> = {
  // 文字
  string: "文字列", String: "文字列", str: "文字列", "std::string": "文字列", "System.String": "文字列", "&str": "文字列", NSString: "文字列",
  char: "1 文字", Character: "1 文字", rune: "1 文字", wchar_t: "1 文字",
  // 整数
  int: "整数", Integer: "整数", long: "大きな整数", Long: "大きな整数", "long long": "大きな整数", short: "小さな整数", Short: "小さな整数",
  byte: "0〜255 の小さな数（1 バイト）", Byte: "小さな数（1 バイト）", sbyte: "小さな整数（1 バイト）",
  uint: "0 以上の整数", ulong: "0 以上の大きな整数", ushort: "0 以上の小さな整数", "unsigned int": "0 以上の整数", unsigned: "0 以上の整数", size_t: "0 以上の整数", usize: "0 以上の整数", isize: "整数",
  int8: "整数（8 ビット）", int16: "整数（16 ビット）", int32: "整数（32 ビット）", int64: "整数（64 ビット）",
  uint8: "0 以上の整数（8 ビット）", uint16: "0 以上の整数（16 ビット）", uint32: "0 以上の整数（32 ビット）", uint64: "0 以上の整数（64 ビット）",
  i8: "整数（8 ビット）", i16: "整数（16 ビット）", i32: "整数（32 ビット）", i64: "整数（64 ビット）", i128: "整数（128 ビット）",
  u8: "0 以上の整数（8 ビット）", u16: "0 以上の整数（16 ビット）", u32: "0 以上の整数（32 ビット）", u64: "0 以上の整数（64 ビット）", u128: "0 以上の整数（128 ビット）",
  BigInteger: "とても大きな整数", bigint: "とても大きな整数",
  // 小数・数
  float: "小数", double: "小数", Float: "小数", Double: "小数", "long double": "小数", float32: "小数（32 ビット）", float64: "小数（64 ビット）", f32: "小数（32 ビット）", f64: "小数（64 ビット）",
  decimal: "小数（お金の計算向け）", Decimal: "小数（お金の計算向け）", BigDecimal: "小数（お金の計算向け）", number: "数", Number: "数", complex: "複素数",
  // はい・いいえ
  bool: "真偽値（true か false）", boolean: "真偽値（true か false）", Boolean: "真偽値（true か false）",
  // 何もない・何でも
  void: "返す値なし", None: "何もない", null: "何もない", undefined: "まだ何もない", nil: "何もない",
  object: "何でも入る", Object: "何でも入る", any: "何でも入る", Any: "何でも入る", dynamic: "何でも入る", "interface{}": "何でも入る", unknown: "まだわからない値",
  // 入れ物
  list: "リスト", List: "リスト", ArrayList: "リスト", LinkedList: "つながったリスト", Array: "配列", vector: "伸び縮みする配列", "std::vector": "伸び縮みする配列", Vec: "伸び縮みする配列",
  dict: "辞書（キーと値の表）", Dictionary: "辞書（キーと値の表）", Map: "辞書（キーと値の表）", HashMap: "辞書（キーと値の表）", TreeMap: "辞書（キーの順に並ぶ表）", "std::map": "辞書（キーと値の表）", Record: "辞書（キーと値の表）",
  set: "集合（同じものは 1 つだけ）", Set: "集合（同じものは 1 つだけ）", HashSet: "集合（同じものは 1 つだけ）", frozenset: "変えられない集合",
  tuple: "タプル（変えられない並び）", Tuple: "タプル（変えられない並び）",
  Queue: "キュー（先に入れたものから出す）", Stack: "スタック（あとに入れたものから出す）", deque: "両はしから出し入れできる並び",
  bytes: "バイト列", bytearray: "書きかえられるバイト列", range: "数の並び",
  // よく使う道具
  error: "エラー", Exception: "エラー", Scanner: "入力を読む道具", StringBuilder: "文字列をつなげる道具", Random: "乱数を作る道具", File: "ファイル",
  // Unity
  GameObject: "ゲームオブジェクト", Transform: "位置・回転・大きさ", Vector3: "3D の位置・向き", Vector2: "2D の位置・向き", Quaternion: "回転",
  Rigidbody: "物理で動かす部品", Rigidbody2D: "物理で動かす部品（2D）", Collider: "当たり判定", Collider2D: "当たり判定（2D）", Collision: "ぶつかった情報",
  Color: "色", Camera: "カメラ", AudioSource: "音を鳴らす部品", AudioClip: "音のデータ", Animator: "アニメーションを動かす部品", Sprite: "画像",
  SpriteRenderer: "画像を表示する部品", Text: "文字の表示", TextMeshProUGUI: "文字の表示", Image: "画像の表示", Button: "ボタン", KeyCode: "キーの種類", Material: "見た目（マテリアル）",
};

/** <...> や [...] の中を、最初の深さでカンマ区切り */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of s) {
    if ("<[(".includes(c)) depth++;
    else if (">])".includes(c)) depth--;
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** 組み合わせた型の中身は、名前だけで書く（「string（文字列）のリスト」と二重にしない） */
const inner = (t: string) => t.trim();

/** 型の意味（日本語）。わからなければ null */
export function typeMeaning(raw: string, lang: TypeLang = "other"): string | null {
  const t = raw.trim().replace(/\s+/g, " ");
  if (!t) return null;
  if (BASE[t]) return lang === "python" && t === "bool" ? "真偽値（True か False）" : BASE[t];
  let m: RegExpExecArray | null;
  // 省略できる：int? / Optional[int] / int | None
  if ((m = /^(.+)\?$/.exec(t))) return `${inner(m[1])}（または何もない）`;
  if ((m = /^Optional\[(.+)\]$/.exec(t))) return `${inner(m[1])}（または None）`;
  if ((m = /^(.+?)\s*\|\s*None$/.exec(t))) return `${inner(m[1])}（または None）`;
  // 配列：int[] / int[][] / Go の []int・[3]int
  if ((m = /^(.+)\[\]\[\]$/.exec(t))) return `${inner(m[1])} の 2 次元配列`;
  if ((m = /^(.+)\[\]$/.exec(t))) return `${inner(m[1])} の配列`;
  if ((m = /^\[\](.+)$/.exec(t))) return `${inner(m[1])} のスライス（伸び縮みする並び）`;
  if ((m = /^\[(\d+)\](.+)$/.exec(t))) return `${inner(m[2])} が ${m[1]} 個の配列`;
  // ポインタ・場所
  if ((m = /^\*(.+)$/.exec(t)) && lang === "go") return `${inner(m[1])} の場所（ポインタ）`;
  if ((m = /^(.+?)\s*\*$/.exec(t))) return `${inner(m[1])} の場所（ポインタ）`;
  if ((m = /^(.+?)\s*&$/.exec(t))) return `${inner(m[1])} そのもの（参照）`;
  // Go の map・chan
  if ((m = /^map\[(.+?)\](.+)$/.exec(t))) return `${inner(m[1])} → ${inner(m[2])} の辞書（マップ）`;
  if ((m = /^chan\s+(.+)$/.exec(t))) return `${inner(m[1])} を送り合うチャネル`;
  // List<int> / list[int] / Dictionary<string, int> / dict[str, int] / std::vector<int> など
  if ((m = /^([\w.:]+)\s*[<[](.+)[>\]]$/.exec(t))) {
    const head = m[1].replace(/^(std|java\.util|System\.Collections\.Generic|typing)(::|\.)/, "");
    const args = splitTop(m[2]);
    if (/^(list|List|ArrayList|LinkedList|IList|IEnumerable|Iterable|Sequence|vector|Vec|Array|ReadonlyArray)$/.test(head)) return `${inner(args[0])} のリスト`;
    if (/^(set|Set|HashSet|SortedSet|frozenset)$/.test(head)) return `${inner(args[0])} の集合（同じものは 1 つだけ）`;
    if (/^(dict|Dict|Dictionary|IDictionary|Map|HashMap|TreeMap|map|unordered_map|Record|Mapping)$/.test(head) && args.length === 2) return `${inner(args[0])} → ${inner(args[1])} の辞書`;
    if (/^(tuple|Tuple)$/.test(head)) return `${args.map(inner).join("・")} のタプル`;
    if (/^(Queue|deque|Deque)$/.test(head)) return `${inner(args[0])} のキュー（先に入れたものから出す）`;
    if (/^(Stack)$/.test(head)) return `${inner(args[0])} のスタック（あとに入れたものから出す）`;
    if (/^(Optional|Option|Nullable)$/.test(head)) return `${inner(args[0])}（または何もない）`;
    if (/^(Promise|Task|Future)$/.test(head)) return `あとで ${inner(args[0])} が届くもの`;
    if (/^(Func|Action|Callable|Function)$/.test(head)) return "関数";
  }
  return null;
}

/** 「string（文字列）」の形。わからない名前は「Point 型」 */
export function typeLabel(raw: string, lang: TypeLang = "other"): string {
  const t = raw.trim();
  const m = typeMeaning(t, lang);
  // かっこが二重にならないよう、意味の中のかっこは「：」にする（bool（真偽値：true か false））
  return m ? `${t}（${m.replace(/（([^（）]+)）/g, "：$1")}）` : `${t} 型`;
}
