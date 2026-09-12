'use strict';
/**
 * 频道内容分类：把博主归到「科技 & AI」「个人成长」这类书签分类里。
 *
 * 为什么不用大模型分类：
 *   分类只需要粗粒度，关键词打分就够用，而且**不花钱、不联网、瞬时完成**。
 *   识别频道时本来就会拿到几百条视频标题，拿来打分即可。
 *
 * 判定依据是**视频标题的内容倾向**，不是频道名 ——
 * 「Mel Robbins」这个名字本身看不出「个人成长」，但它的视频标题里
 * 满是 motivate / habit / mindset 这类词，一眼就能归对。
 */

/** 分类定义（顺序即书签栏顺序，other 固定最后）
 *  name  = 完整名，显示在频道卡片上
 *  short = 书签名，要短，否则 8 个标签会换行、破坏书签的连贯观感
 */
const CATEGORIES = [
  {
    id: 'tech',
    name: '科技 & AI',
    short: '科技',
    icon: '🤖',
    keywords: [
      'ai', 'a.i.', 'artificial intelligence', 'gpt', 'chatgpt', 'llm', 'model', 'neural',
      'machine learning', 'deep learning', 'agent', 'agentic', 'api', 'code', 'coding',
      'programming', 'developer', 'software', 'engineer', 'python', 'javascript', 'rust',
      'linux', 'open source', 'startup tech', 'robot', 'robotics', 'automation', 'computer',
      'silicon', 'chip', 'gpu', 'nvidia', 'apple', 'google', 'microsoft', 'openai', 'tech',
      'technology', 'internet', 'cyber', 'security', 'hacker', 'data science', 'algorithm',
      'quantum', 'vr', 'ar', 'metaverse', 'crypto', 'blockchain',
    ],
  },
  {
    id: 'growth',
    name: '个人成长',
    short: '成长',
    icon: '🌱',
    keywords: [
      'motivat', 'habit', 'mindset', 'discipline', 'confidence', 'self', 'goal', 'goal setting',
      'productiv', 'procrastinat', 'focus', 'routine', 'morning', 'journal', 'gratitude',
      'anxiety', 'depress', 'stress', 'burnout', 'therapy', 'healing', 'trauma', 'boundaries',
      'relationship', 'love', 'marriage', 'dating', 'parenting', 'purpose', 'meaning',
      'success', 'fail', 'change your life', 'transform', 'improve', 'better', 'growth',
      'mindfulness', 'meditation', 'stoic', 'philosophy of life', 'advice', 'lessons',
      'overcome', 'resilien', 'courage', 'fear', 'lonely', 'happiness', 'joy',
    ],
  },
  {
    id: 'health',
    name: '健康 & 科学',
    short: '健康',
    icon: '🧬',
    keywords: [
      'health', 'doctor', 'medical', 'medicine', 'sleep', 'diet', 'nutrition', 'exercise',
      'workout', 'fitness', 'muscle', 'weight', 'metabolis', 'hormone', 'brain', 'neuro',
      'dopamine', 'cortisol', 'longevity', 'aging', 'gut', 'microbiome', 'immune', 'cancer',
      'disease', 'supplement', 'vitamin', 'protein', 'fasting', 'cardio', 'science',
      'scientist', 'research', 'study', 'physics', 'chemistry', 'biology', 'gene', 'dna',
      'cell', 'mitochondria', 'evolution', 'space', 'nasa', 'astronom', 'climate', 'nature',
      'professor', 'stanford', 'harvard', 'mit', 'lab',
    ],
  },
  {
    id: 'business',
    name: '商业 & 财经',
    short: '商业',
    icon: '📈',
    keywords: [
      'business', 'money', 'finance', 'financial', 'invest', 'stock', 'market', 'economy',
      'economic', 'entrepreneur', 'founder', 'ceo', 'company', 'corporation', 'revenue',
      'profit', 'sales', 'marketing', 'brand', 'customer', 'growth hacking', 'ecommerce',
      'real estate', 'tax', 'wealth', 'rich', 'millionaire', 'billionaire', 'salary',
      'career', 'job', 'interview tips', 'negotiat', 'leadership', 'management', 'strategy',
      'venture', 'vc', 'ipo', 'inflation', 'recession', 'bitcoin', 'trading', 'portfolio',
    ],
  },
  {
    id: 'knowledge',
    name: '人文 & 历史',
    short: '人文',
    icon: '📚',
    keywords: [
      'history', 'historical', 'war', 'empire', 'ancient', 'civilization', 'revolution',
      'politics', 'political', 'president', 'government', 'law', 'legal', 'constitution',
      'philosophy', 'philosopher', 'ethics', 'religion', 'islam', 'christian', 'buddhis',
      'culture', 'society', 'sociolog', 'psycholog', 'anthropolog', 'archaeolog', 'literature',
      'book', 'author', 'writing', 'language', 'linguistic', 'education', 'school', 'learn',
      'english', 'grammar', 'vocabulary', 'lecture', 'course', 'lesson', 'tutorial',
      'documentary', 'explained', 'story of', 'rise and fall', 'interview', 'podcast',
    ],
  },
  {
    id: 'life',
    name: '娱乐 & 生活',
    short: '娱乐',
    icon: '🍿',
    keywords: [
      'funny', 'comedy', 'prank', 'challenge', 'reaction', 'vlog', 'game', 'gaming',
      'minecraft', 'fortnite', 'music', 'song', 'album', 'concert', 'singer', 'band',
      'movie', 'film', 'trailer', 'celebrity', 'actor', 'sport', 'football', 'soccer',
      'basketball', 'nba', 'mma', 'ufc', 'boxing', 'fitness challenge', 'food', 'cook',
      'recipe', 'restaurant', 'travel', 'trip', 'tour', 'hotel', 'car', 'review', 'unbox',
      'diy', 'craft', 'pet', 'dog', 'cat', 'beauty', 'fashion', 'makeup', 'home', 'garden',
    ],
  },
];

/** 兜底分类 */
const OTHER = { id: 'other', name: '其他', short: '其他', icon: '📁' };

/** 至少命中多少次才算数（避免一两次偶然命中就把频道归错） */
const MIN_SCORE = 2;

/** ASCII 关键词用词边界匹配，避免 "ai" 命中 "said"、"again" */
function countHits(text, kw) {
  if (/^[a-z0-9 .&]+$/.test(kw)) {
    // 纯 ASCII 关键词：要求前后不是字母数字
    const re = new RegExp(`(^|[^a-z0-9])${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'gi');
    let n = 0;
    while (re.exec(text)) n++;
    return n;
  }
  // 含中文或特殊符号：直接子串计数
  let n = 0;
  let i = -1;
  while ((i = text.indexOf(kw, i + 1)) !== -1) n++;
  return n;
}

/**
 * 按视频标题给频道分类。
 * @param {string[]} titles 该频道的视频标题（几十到几百条都行）
 * @returns {{id:string, name:string, icon:string, scores:object}} 得分明细便于排查
 */
function classifyTitles(titles) {
  const text = ' ' + (titles || []).map((t) => String(t || '').toLowerCase()).join(' \n ') + ' ';
  const scores = {};
  for (const c of CATEGORIES) {
    let s = 0;
    for (const kw of c.keywords) s += countHits(text, kw);
    scores[c.id] = s;
  }
  let best = OTHER;
  let bestScore = 0;
  for (const c of CATEGORIES) {
    if (scores[c.id] > bestScore) {
      bestScore = scores[c.id];
      best = c;
    }
  }
  if (bestScore < MIN_SCORE) best = OTHER;
  return { id: best.id, name: best.name, icon: best.icon, score: bestScore, scores };
}

/** 取分类元信息（给界面用；未知 id 归到「其他」） */
function categoryOf(id) {
  return CATEGORIES.find((c) => c.id === id) || OTHER;
}

/** 书签栏要显示的全部分类（含兜底） */
function allCategories() {
  return CATEGORIES.concat([OTHER]).map((c) => ({
    id: c.id,
    name: c.name,
    short: c.short || c.name,
    icon: c.icon,
  }));
}

module.exports = { CATEGORIES, OTHER, allCategories, categoryOf, classifyTitles, MIN_SCORE };
