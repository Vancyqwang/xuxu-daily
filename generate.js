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
    { name: '机器之心', url: 'https://www.jiqizhixin.com/rss' },
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

// ===== 3. 调混元 API 总结成日报 =====
async function summarizeWithHunyuan(rawItems) {
  const itemsText = rawItems.map((item, i) =>
    `${i + 1}. [${item.source}] ${item.title}\n   摘要: ${item.desc}\n   链接: ${item.url}`
  ).join('\n\n');

  const prompt = `你是西西的 AI 电子秘书「嘘嘘」，每天帮她整理 AI 领域最新动态。
西西的背景：腾讯云产品部门秘书，非技术背景，关注 AI 编程/具身智能/产品设计，正在学习 vibe coding。

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
  "summary": "一句话总结（不超过50字，技术人员视角）",
  "plain_chinese": "小白版解读（2-3句话，要求：①完全不用任何技术词汇，把 LLM/框架/模型/API 等词都替换成生活化比喻；②假设读者是一个完全不懂技术的行政秘书；③用「就是说」「相当于」「打个比方」这类口语表达；④说清楚这件事在现实生活中意味着什么）",
  "relevance": "和西西有什么关系（1-2句，具体说明对她的工作或学习有什么价值）",
  "url": "原文链接",
  "source": "来源"
}

原始内容：
${itemsText}

请只返回 JSON 数组，不要加其他内容，不要加 markdown 代码块。格式：
[{"category":"...","title":"...","summary":"...","plain_chinese":"...","relevance":"...","url":"...","source":"..."},...]`;

  try {
    const completion = await client.chat.completions.create({
      model: 'glm-4.7-flash',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
    });

    const content = completion.choices?.[0]?.message?.content || '';
    console.log('混元返回内容（前500字）：', content.slice(0, 500));

    if (!content) { console.log('混元返回为空'); return []; }

    // 尝试多种方式提取 JSON
    let jsonStr = '';
    const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) jsonStr = codeBlockMatch[1].trim();
    if (!jsonStr) {
      const arrayMatch = content.match(/\[[\s\S]*\]/);
      if (arrayMatch) jsonStr = arrayMatch[0];
    }
    if (!jsonStr) jsonStr = content.trim();

    try {
      const result = JSON.parse(jsonStr);
      return Array.isArray(result) ? result : [];
    } catch (e) {
      console.log('JSON 解析失败：', e.message);
      return [];
    }
  } catch (e) {
    console.log('混元 API 调用失败：', e.message);
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

  console.log(`📦 GitHub: ${githubItems.length} 条，RSS: ${rssItems.length} 条`);

  // RSS 新闻通过 AI 总结
  const summaries = rssItems.length > 0 ? await summarizeWithHunyuan(rssItems) : [];
  console.log(`✅ AI 精选出 ${summaries.length} 条新闻`);

  // GitHub 项目也通过 AI 生成小白解读
  let githubFormatted = githubItems.map(item => ({
    category: '⭐ GitHub',
    title: item.title,
    summary: item.desc || '暂无描述',
    plain_chinese: '',
    relevance: '',
    url: item.url,
    source: 'GitHub',
    stars: item.stars
  }));

  // 用 AI 给 GitHub 项目写小白解读
  if (githubItems.length > 0 && GLM_API_KEY) {
    try {
      const ghText = githubItems.map((item, i) =>
        `${i + 1}. ${item.title}（⭐${item.stars?.toLocaleString()}）\n   描述: ${item.desc || '无'}\n   链接: ${item.url}`
      ).join('\n\n');

      const ghPrompt = `你是西西的电子秘书「嘘嘘」。西西是非技术背景的行政秘书，正在学习 AI 编程。
请为以下 GitHub 项目各写两段话：
1. plain_chinese：用大白话解释这个项目是做什么的（2-3句，完全不用技术词汇，用生活化比喻，假设读者完全不懂编程）
2. relevance：和西西的学习有什么关系（1句话）

项目列表：
${ghText}

请只返回 JSON 数组，格式：
[{"title":"项目名","plain_chinese":"...","relevance":"..."},...]
不要加 markdown 代码块。`;

      const ghCompletion = await client.chat.completions.create({
        model: 'glm-4.7-flash',
        messages: [{ role: 'user', content: ghPrompt }],
        temperature: 0.3,
      });

      const ghContent = ghCompletion.choices?.[0]?.message?.content || '';
      let ghJsonStr = '';
      const ghCodeBlock = ghContent.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (ghCodeBlock) ghJsonStr = ghCodeBlock[1].trim();
      if (!ghJsonStr) { const m = ghContent.match(/\[[\s\S]*\]/); if (m) ghJsonStr = m[0]; }
      if (!ghJsonStr) ghJsonStr = ghContent.trim();

      try {
        const ghParsed = JSON.parse(ghJsonStr);
        if (Array.isArray(ghParsed)) {
          githubFormatted = githubFormatted.map(item => {
            const match = ghParsed.find(p => item.title.includes(p.title) || p.title.includes(item.title.split('/').pop()));
            if (match) {
              item.plain_chinese = match.plain_chinese || '';
              item.relevance = match.relevance || '';
            }
            return item;
          });
        }
      } catch(e) { console.log('GitHub AI 解读解析失败:', e.message); }
    } catch(e) { console.log('GitHub AI 解读失败:', e.message); }
  }

  // 没有 AI 解读的用默认
  githubFormatted = githubFormatted.map(item => ({
    ...item,
    plain_chinese: item.plain_chinese || `这是一个 GitHub 上很受欢迎的 AI 项目（${item.stars?.toLocaleString() || '大量'}人收藏）：${item.summary}`,
    relevance: item.relevance || '关注 AI 领域前沿开源项目，了解开发者社区在用什么。'
  }));
  // 移除 stars 字段
  githubFormatted.forEach(item => delete item.stars);

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
