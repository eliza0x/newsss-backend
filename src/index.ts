import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { load } from 'cheerio';

type Bindings = {
  KV: KVNamespace
}

async function get_news_detail(kv: KVNamespace, url: string): Promise<string> {
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
}

function today() {
  // 日本時間を取得
  const dt = new Date(Date.now() + ((new Date().getTimezoneOffset() + (9 * 60)) * 60 * 1000));
  const y = dt.getFullYear();
  const m = ('00' + (dt.getMonth() + 1)).slice(-2);
  const d = ('00' + dt.getDate()).slice(-2);
  return y + m + d;
}

function now() {
  // 日本時間を取得
  const dt = new Date(Date.now() + ((new Date().getTimezoneOffset() + (9 * 60)) * 60 * 1000));
  const y = dt.getFullYear();
  const m = ('00' + (dt.getMonth() + 1)).slice(-2);
  const d = ('00' + dt.getDate()).slice(-2);
  const h = ('00' + dt.getHours()).slice(-2);
  return y + m + d + h;
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

async function get_news(url: string) {
  let t = today()
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

// function gen_chat(s: string) {
//   return {
//     messages: [
//       { role: 'system', content: '日本語で回答してください。' },
//       { role: 'user', content: s },
//     ]
//   }
// }
// 
// async function ask_ai(ai: any, s: string) {
//   let chat = gen_chat(s);
//   let resp = await ai.run('@cf/meta/llama-3-8b-instruct', chat);
//   let ret = resp['response'] as string
//   return { Q: s, A: ret }
// }

async function get_newses(kv: KVNamespace, date: string = today()) {
  const t = now()
  const is_today = date === today().slice(0, 4) // 日を比較したいので、時間以降の情報をtrim
  if (is_today) {
    // 今日のニュースは更新されていくので１時間単位でcache
    let cache = await kv.get(t)
    if (cache) {
      cache = JSON.parse(cache)
      return cache
    }
  } else {
    // 過去のニュースは一日単位でcache
    let cache = await kv.get(date)
    if (cache) {
      cache = JSON.parse(cache)
      return cache
    }
  }

  let news = await Promise.all(caterogry.map(async (c) => {
    let url = news_url(c, date)
    let news =  await get_news(url)
    let ret = await Promise.all(news.map(async (n) => {
      let d = await get_news_detail(kv, n.link)
      return {date: date, title: n.title, detail: d, category: c, link: n.link}
    }))
    return ret
  }))
  let ret = news.flat()
  if (is_today) {
    await kv.put(t, JSON.stringify(ret))
  } 
  await kv.put(date, JSON.stringify(ret))
  return ret
}

const app = new Hono<{ Bindings: Bindings }>()
app.use('/*', cors())
app.get('/:date', async (c) => {
  let date = c.req.param('date')
  let ret = await get_newses(c.env.KV, date)
  return c.json(ret);
})
app.use('/', cors())
app.get('/', async (c) => {
  // const ai = c.env.AI
  // const tasks: {Q: string, A: string}[] = [];
  // tasks.push(await ask_ai(ai, '日本の首都はどこですか？'));
  // tasks.push(await ask_ai(ai, '日本の首相は誰ですか？'));
  // tasks.push(await ask_ai(ai, '奈良県にwhopperはありますか？'));

  let ret = await get_newses(c.env.KV)
  return c.json(ret);
})


export default app
