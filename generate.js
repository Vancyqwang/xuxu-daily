import fetch from 'node-fetch';
import Parser from 'rss-parser';
import fs from 'fs';
import path from 'path';

const HUNYUAN_API_KEY = process.env.HUNYUAN_API_KEY;
const parser = new Parser({ timeout: 10000 });

// ===== 1. 抓取 GitHub Trending（AI 相关） =====
async function fetchGithubTrending() {
  try {
    const res = await fetch(
      'https://api.github.com/search/repositories?q=topic:ai+topic:llm&sort=stars&order=desc&per_page=10&created:>' + getDateBefore(7),
      { headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'xuxu-daily-bot' } }
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
    { name: '36kr AI', url: 'https://36kr.com/feed' },
    { name: 'Hacker News', url: 'https://hnrss.org/frontpage?q=AI+LLM&count=20' },
    { name: '机器之心', url: 'https://www.jiqizhixin.com/rss' },
  ];

  const items = [];
  for (const source of sources) {
    try {
      const feed = await parser.parseURL(source.url);
      const recent = (feed.items || []).slice(0, 5).map(item => ({
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

// ===== 3. 调混元 API 总结成日报 =====
async function summarizeWithHunyuan(rawItems) {
  const itemsText = rawItems.map((item, i) =>
    `${i + 1}. [${item.source}] ${item.title}\n   摘要: ${item.desc}\n   链接: ${item.url}`
  ).join('\n\n');

  const prompt = `你是西西的 AI 电子秘书「嘘嘘」，每天帮她整理 AI 领域最新动态。
西西的背景：腾讯云产品部门秘书，关注 AI 编程/具身智能/产品设计，正在学习 vibe coding。

请从以下原始新闻中，精选 5-8 条最值得关注的内容，按分类整理成日报。

分类规则：
- 🤖 大模型：大语言模型、多模态、基础模型相关
- 🦾 具身智能：机器人、物理世界 AI、传感器相关
- 🛠️ 工具：AI 工具、开发框架、产品发布
- 📄 论文/研究：学术成果、技术突破

每条格式：
{
  "category": "分类名",
  "title": "标题（简洁中文，不超过30字）",
  "summary": "一句话总结（不超过50字）",
  "relevance": "和西西有什么关系（1-2句，具体说明对她的工作或学习有什么价值）",
  "url": "原文链接",
  "source": "来源"
}

原始内容：
${itemsText}

请只返回 JSON 数组，不要加其他内容。格式：
[
  { "category": "...", "title": "...", "summary": "...", "relevance": "...", "url": "...", "source": "..." },
  ...
]`;

  try {
    const res = await fetch('https://api.hunyuan.cloud.tencent.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${HUNYUAN_API_KEY}`
      },
      body: JSON.stringify({
        model: 'hunyuan-pro',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3
      })
    });

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '[]';

    // 提取 JSON
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return [];
  } catch (e) {
    console.log('Hunyuan API failed:', e.message);
    return [];
  }
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

  const allItems = [...githubItems, ...rssItems];
  console.log(`📦 共抓取 ${allItems.length} 条原始内容`);

  if (allItems.length === 0) {
    console.log('⚠️ 没有抓到内容，跳过生成');
    return;
  }

  // 混元总结
  const summaries = await summarizeWithHunyuan(allItems);
  console.log(`✅ 混元精选出 ${summaries.length} 条`);

  // 构建日报 JSON
  const daily = {
    date: today,
    generated_at: new Date().toISOString(),
    items: summaries,
    raw_count: allItems.length
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
