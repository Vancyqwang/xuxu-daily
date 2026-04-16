import OpenAI from 'openai';
import Parser from 'rss-parser';
import fs from 'fs';
import path from 'path';

const GLM_API_KEY = process.env.ZHIPU_API_KEY;
const parser = new Parser({ timeout: 10000 });

const client = new OpenAI({
  apiKey: GLM_API_KEY,
  baseURL: 'https://open.bigmodel.cn/api/paas/v4/',
});

// ===== 1. 抓取 GitHub Trending（AI 相关） =====
async function fetchGithubTrending() {
  try {
    const res = await fetch(
      'https://api.github.com/search/repositories?q=topic:ai+topic:llm&sort=stars&order=desc&per_page=10&created:>' + getDateBefore(7),
      { headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'xuxu-daily-bot' }, signal: AbortSignal.timeout(15000) }
    );
    const data = await res.json();
    return (data.items || []).slice(0, 5).map(r => ({
      title: r.full_name,
      desc: r.description || '',
      url: r.html_url,
      stars: r.stargazers_count,
      source: 'GitHub'
    }));
  } catch (e) {
    console.log('GitHub fetch failed:', e.message);
    return [];
  }
}

// ===== 2. 抓取 RSS 新闻源 =====
async function fetchRSS() {
  const sources = [
    // 国内
    { name: '36kr AI', url: 'https://36kr.com/feed' },
    { name: '量子位', url: 'https://www.qbitai.com/feed' },
    // 国际
    { name: 'Hacker News AI', url: 'https://hnrss.org/frontpage?q=AI+LLM+GPT&count=20' },
    { name: 'MIT Tech Review AI', url: 'https://www.technologyreview.com/feed/' },
    { name: 'VentureBeat AI', url: 'https://venturebeat.com/category/ai/feed/' },
  ];

  const items = [];
  for (const source of sources) {
    try {
      // 单个源最多等 15 秒
      const feedPromise = parser.parseURL(source.url);
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000));
      const feed = await Promise.race([feedPromise, timeoutPromise]);
      const recent = (feed.items || []).slice(0, 8).map(item => ({
        title: item.title || '',
        desc: item.contentSnippet?.slice(0, 200) || item.summary?.slice(0, 200) || '',
        url: item.link || '',
        source: source.name,
        pubDate: item.pubDate || item.isoDate || ''
      }));
      items.push(...recent);
    } catch (e) {
      console.log(`RSS fetch failed for ${source.name}:`, e.message);
    }
  }
  return items;
}

// ===== 3. 调智谱 API 总结成日报（含 GitHub 解读） =====
async function summarizeWithZhipu(rawItems, githubItems) {
  const itemsText = rawItems.map((item, i) =>
    `${i + 1}. [${item.source}] ${item.title}\n   摘要: ${item.desc}\n   链接: ${item.url}`
  ).join('\n\n');

  const ghText = githubItems.map((item, i) =>
    `GH${i + 1}. ${item.title}（⭐${item.stars?.toLocaleString()}）\n   描述: ${item.desc || '无'}\n   链接: ${item.url}`
  ).join('\n\n');

  const prompt = `你是西西的 AI 电子秘书「嘘嘘」，每天帮她整理 AI 领域最新动态。
西西的背景：腾讯云产品部门秘书，非技术背景，关注 AI 编程/具身智能/产品设计，正在学习 vibe coding。

【第一部分】从以下原始新闻中，精选 5-8 条最值得关注的内容，按分类整理。
每条格式：{"type":"news","category":"分类","title":"标题（中文30字内）","summary":"一句话总结50字内","plain_chinese":"小白解读2-3句，完全不用技术词汇，用生活化比喻","relevance":"和西西的关系1句","url":"链接","source":"来源"}

分类：🤖 大模型 / 🦾 具身智能 / 🛠️ 工具 / 📄 论文研究

【第二部分】为以下 ${githubItems.length} 个 GitHub 项目各写中文解读。
每条格式：{"type":"github","title":"项目名","plain_chinese":"大白话解释2句，不用技术词汇","relevance":"对西西学 AI 编程的价值1句","url":"链接"}

原始新闻：
${itemsText}

GitHub 项目：
${ghText}

只返回一个 JSON 数组，包含新闻和 GitHub 两类数据，不加 markdown 代码块：`;

  try {
    const completion = await client.chat.completions.create({
      model: 'glm-4.7-flash',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
    });

    const content = completion.choices?.[0]?.message?.content || '';
    console.log('AI 返回内容（前500字）：', content.slice(0, 500));

    if (!content) { console.log('AI 返回为空'); return { news: [], github: [] }; }

    let jsonStr = '';
    const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) jsonStr = codeBlockMatch[1].trim();
    if (!jsonStr) { const m = content.match(/\[[\s\S]*\]/); if (m) jsonStr = m[0]; }
    if (!jsonStr) jsonStr = content.trim();

    try {
      const result = JSON.parse(jsonStr);
      if (Array.isArray(result)) {
        const news = result.filter(r => r.type === 'news').map(r => ({
          category: r.category, title: r.title, summary: r.summary,
          plain_chinese: r.plain_chinese, relevance: r.relevance,
          url: r.url, source: r.source
        }));
        const github = result.filter(r => r.type === 'github').map((r, i) => ({
          category: '⭐ GitHub',
          title: githubItems[i]?.title || r.title,
          summary: githubItems[i]?.desc || '',
          plain_chinese: r.plain_chinese || '',
          relevance: r.relevance || '',
          url: githubItems[i]?.url || r.url,
          source: 'GitHub'
        }));
        return { news, github };
      }
    } catch (e) {
      console.log('JSON 解析失败：', e.message);
    }
  } catch (e) {
    console.log('智谱 API 调用失败：', e.message);
  }
  return { news: [], github: [] };
}

// ===== 4. 主流程 =====
async function main() {
  console.log('🚀 开始生成日报...');
  const today = new Date().toISOString().split('T')[0];

  // 抓取数据
  const [githubItems, rssItems] = await Promise.all([
    fetchGithubTrending(),
    fetchRSS()
  ]);

  console.log(`📦 GitHub: ${githubItems.length} 条，RSS: ${rssItems.length} 条`);

  // 一次 AI 调用搞定新闻总结 + GitHub 解读
  const { news: summaries, github: githubFormatted } = rssItems.length > 0
    ? await summarizeWithZhipu(rssItems, githubItems)
    : { news: [], github: githubItems.map(item => ({
        category: '⭐ GitHub', title: item.title,
        summary: item.desc || '', plain_chinese: item.desc || '',
        relevance: '关注 AI 领域前沿开源项目。', url: item.url, source: 'GitHub'
      }))};
  console.log(`✅ AI 精选出 ${summaries.length} 条新闻，${githubFormatted.length} 个 GitHub 解读`);

  // 构建日报 JSON
  const daily = {
    date: today,
    generated_at: new Date().toISOString(),
    items: summaries,          // AI 总结的新闻
    github: githubFormatted,   // GitHub 项目独立存储
    raw_count: githubItems.length + rssItems.length
  };

  // 保存
  const docsDir = path.join(process.cwd(), 'docs');
  if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir);

  // 当天日报
  fs.writeFileSync(path.join(docsDir, `${today}.json`), JSON.stringify(daily, null, 2), 'utf-8');

  // 最新日报（前端直接读这个）
  fs.writeFileSync(path.join(docsDir, 'latest.json'), JSON.stringify(daily, null, 2), 'utf-8');

  // 历史索引
  const indexFile = path.join(docsDir, 'index.json');
  const index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf-8')) : [];
  if (!index.includes(today)) {
    index.unshift(today);
    index.splice(30); // 只保留最近 30 天
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2), 'utf-8');
  }

  console.log(`📰 日报已生成：${today}`);
}

function getDateBefore(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}

main().catch(console.error);
