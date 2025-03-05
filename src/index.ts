import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { load } from 'cheerio';

type Bindings = {
  DAILY_CACHE: KVNamespace,
  YAHOO_DETAIL: KVNamespace,
  NHK_CACHE: KVNamespace
}

type News = {
  title: string,
  detail: string,
  category: string,
  link: string
}

function today() {
  // 日本時間を取得
  const dt = new Date(Date.now() + ((new Date().getTimezoneOffset() + (9 * 60)) * 60 * 1000));
  const y = dt.getFullYear();
  const m = ('00' + (dt.getMonth() + 1)).slice(-2);
  const d = ('00' + dt.getDate()).slice(-2);
  return y + m + d;
}

function today_day() {
  // 日本時間を取得
  const dt = new Date(Date.now() + ((new Date().getTimezoneOffset() + (9 * 60)) * 60 * 1000));
  const d = ('00' + dt.getDate()).slice(-2);
  return d;
}

async function get_cache(kv: KVNamespace, date: string): Promise<News[] | null> {
  let cache = await kv.get(date)
  if (cache) {
    let ret = JSON.parse(cache)
    return ret as News[]
  }
  return null
}

async function update_cache(kv: KVNamespace, date: string, news: News[]) {
  const is_today = date === today()
  if (is_today) {
    await kv.put(date, JSON.stringify(news), {expirationTtl: 60 * 30}) // 今日の記事はどんどん更新されるので30分単位でexpire
  } else {
    await kv.put(date, JSON.stringify(news))
  }
}

async function cacheing(kv: KVNamespace, date: string, f: () => Promise<News[]>): Promise<News[]> {
  let cache = await get_cache(kv, date)
  if (cache) {
    return cache
  }
  let news = await f()
  if (news.length != 0) {
    await update_cache(kv, date, news)
  }
  return news
}

async function get_yahoo_news(bind: Bindings, date: string = today()): Promise<News[]> {
  async function get_news_detail(kv: KVNamespace, url: string): Promise<string> {
    try {
      let cache = await kv.get(url)
      if (cache) {
        return cache
      }

      let data = await fetch(url)
      let body = await data.text()
      let $ = load(body)
      let ret = $('.highLightSearchTarget', 'article').text()

      if (ret.length > 0) {
        await kv.put(url, ret)
      }
      return ret
    } catch (e) {
      console.error('記事の詳細の取得に失敗: ' + e)
      return '記事の詳細の取得に失敗'
    }
  }

  let caterogry: string[] = [
    'domestic',
    'world',
    'business',
    'it',
    'science'
  ]

  async function get_news(url: string): Promise<{title: string, link: string}[]> {
    let data = await fetch(url)
    let body = await data.text()
    let $ = load(body);
    const ret: {title: string, link: string}[] = []
    $('li', '.newsFeed_list').each((i, elem) => {
        // elemの子要素が持っているtextを配列で取得
        let item = $(elem).find('a')
        let link = $(item).attr('href') as string

        let title_node = $(item).children().get()[1]
        let title = $(title_node).children().get()[0]
        let t = $(title).text() as string

        ret.push({title: t, link: link})
    })
    return ret;
  }

  async function get_newses(bind: Bindings, date: string) {
    return await cacheing(bind.DAILY_CACHE, date, async () => {
      let news = await Promise.all(caterogry.map(async (c) => {
        let news_by_category =  await get_news('https://news.yahoo.co.jp/topics/' + c + '?date=' + date)
        return await Promise.all(news_by_category.map(async (n) => {
          let d = await get_news_detail(bind.YAHOO_DETAIL, n.link)
          return {title: n.title, detail: d, category: c, link: n.link}
        }))
      }))
      return news.flat()
    });
  }

  return await get_newses(bind, date)
}

import Parser from 'rss-parser';
async function rss_handler(cache: KVNamespace | null, urls: string[], custom_filter: (item: News) => boolean = (_item: News) => true): Promise<News[]> {
  async function parse() {
    let newses = await Promise.all(urls.map(async (url) => {
      let data = await fetch(url)
      let body = await data.text()
      let feed = await new Parser().parseString(body)
      return feed.items.map((item) => {
        const ret = {title: item.title, detail: item.content, category: item.categories?.toString(), link: item.link} as News; 
        return ret
      }).filter((item) => custom_filter(item))
    }))
    return newses.flat();
  }
  if (cache == null) {
    return await parse()
  } else {
    return await cacheing(cache, today(), parse);
  }
}

async function get_nhk_news(bind: Bindings): Promise<News[]> {
  function is_today(item: News): boolean {
    // "http://www3.nhk.or.jp/news/html/20250207/k10014716431000.html".split("/")[5] => "20250207"
    try {
      return item.link.split("/")[5] == today()
    } catch (e) {
      console.error('NHKの記事の日付の取得に失敗: ' + item)
      return false
    }
  }
  let urls = [
    "https://www.nhk.or.jp/rss/news/cat1.xml", // 社会
    "https://www.nhk.or.jp/rss/news/cat3.xml", // 科学・医療
    "https://www.nhk.or.jp/rss/news/cat4.xml", // 政治
    "https://www.nhk.or.jp/rss/news/cat5.xml", // 経済
    "https://www.nhk.or.jp/rss/news/cat6.xml"  // 国際
  ]
  return rss_handler(bind.NHK_CACHE, urls, is_today)
}

type RssHandler = (bind: Bindings) => Promise<News[]>
const rss_handlers: {'path': string, 'name': string, 'handler': RssHandler}[] = [
  {'path': 'nhk', 'name': 'NHK', 'handler': get_nhk_news},
  {'path': 'monoist', 'name': 'MONOist', 'handler': () => rss_handler(null, ['https://rss.itmedia.co.jp/rss/2.0/monoist.xml'])},
  {'path': 'itmediaai', 'name': 'ITmedia AI+', 'handler': () => rss_handler(null, ['https://rss.itmedia.co.jp/rss/2.0/aiplus.xml'])},
  {'path': 'itmedianews', 'name': 'ITmedia News', 'handler': () => rss_handler(null, ['https://rss.itmedia.co.jp/rss/2.0/news_bursts.xml'])},
  {'path': 'zenn', 'name': 'Zenn', 'handler': () => rss_handler(null, ['https://zenn.dev/feed'])},
  {'path': 'gigazine', 'name': 'GIGAZINE', 'handler': () => rss_handler(null, ['https://gigazine.net/news/rss_2.0/'])},
  {'path': 'nature', 'name': 'Nature', 'handler': () => rss_handler(null, ['https://www.nature.com/nature.rss'])},
]

const app = new Hono<{ Bindings: Bindings }>()

app.use('/resources', cors())
app.get('/resources', async (c) => {
  return c.json(rss_handlers.map((h) => {return {path: h.path, name: h.name}})
  )
})

app.use('/*', cors())
app.get('/:path', async (c) => {
  let path = c.req.param('path')

  // rssのハンドラを探して、あればそれを返す。
  const news = await rss_handlers.find((h) => h.path === path)?.handler(c.env);
  if (news) {
    return c.json(news)
  }

  // ない場合は、yahooのニュースを取得
  // dateが全て数字であり、8桁であることを確認
  if (!path.match(/^\d+$/) || path.length !== 8) {
    return c.notFound()
  }

  let ret = await get_yahoo_news(c.env, path)
  return c.json(ret);
})
app.use('/', cors())
app.get('/', async (c) => {
  let ret = await get_yahoo_news(c.env)
  return c.json(ret);
})

async function scheduled(event: Request, env: Bindings, ctx: ExecutionContext) {
  // 今日の日付のキャッシュを更新
  await get_nhk_news(env)
  return new Response('ok')
}

export default {
  fetch: app.fetch,
  scheduled: scheduled
}
