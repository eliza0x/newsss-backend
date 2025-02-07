import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { load } from 'cheerio';

type Bindings = {
  DAILY_CACHE: KVNamespace,
  YAHOO_DETAIL: KVNamespace,
}

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

function today() {
  // 日本時間を取得
  const dt = new Date(Date.now() + ((new Date().getTimezoneOffset() + (9 * 60)) * 60 * 1000));
  const y = dt.getFullYear();
  const m = ('00' + (dt.getMonth() + 1)).slice(-2);
  const d = ('00' + dt.getDate()).slice(-2);
  return y + m + d;
}

let caterogry: string[] = [
  'domestic',
  'world',
  'business',
  'it',
  'science'
]

function news_url(category: string, date: string) {
  return 'https://news.yahoo.co.jp/topics/' + category + '?date=' + date
}

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

type News = {
  title: string,
  detail: string,
  category: string,
  link: string
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

async function get_newses(bind: Bindings, date: string = today()) {
  return await cacheing(bind.DAILY_CACHE, date, async () => {
    let news = await Promise.all(caterogry.map(async (c) => {
      let news_by_category =  await get_news(news_url(c, date))
      return await Promise.all(news_by_category.map(async (n) => {
        let d = await get_news_detail(bind.YAHOO_DETAIL, n.link)
        return {title: n.title, detail: d, category: c, link: n.link}
      }))
    }))
    return news.flat()
  });
}

const app = new Hono<{ Bindings: Bindings }>()
app.use('/*', cors())
app.get('/:date', async (c) => {
  let date = c.req.param('date')

  // dateが全て数字であり、8桁であることを確認
  if (!date.match(/^\d+$/) || date.length !== 8) {
    return c.notFound()
  }

  let ret = await get_newses(c.env, date)
  return c.json(ret);
})
app.use('/', cors())
app.get('/', async (c) => {
  let ret = await get_newses(c.env)
  return c.json(ret);
})

export default app
