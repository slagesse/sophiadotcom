import 'dotenv/config'
import express from 'express'
import multer from 'multer'
import { nanoid } from 'nanoid'
import { createClient } from '@supabase/supabase-js'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } })
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE)
const BUCKET = process.env.SUPABASE_BUCKET || 'private-photos'
const PORT = process.env.PORT || 3000

app.use(express.static(__dirname))
app.use(express.json())

app.get('/healthz', (req, res) => res.status(200).send('ok'))

app.get('/api/posts', async (req, res) => {
  const { data, error } = await supabase.from('posts').select('*').order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  const ids = data.map(p => p.id)
  const { data: likeRows } = await supabase.from('post_likes').select('post_id, count').in('post_id', ids)
  const likeMap = Object.fromEntries((likeRows || []).map(r => [r.post_id, r.count]))
  const signed = await Promise.all(
    data.map(async p => {
      const { data: url } = await supabase.storage.from(BUCKET).createSignedUrl(p.image_path, 3600)
      return { ...p, signed_url: url?.signedUrl || null, like_count: likeMap[p.id] || 0 }
    })
  )
  res.json(signed)
})

app.post('/api/posts', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' })
  const id = nanoid()
  const ext = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase()
  const key = `${id}.${ext}`
  const { error: upErr } = await supabase.storage.from(BUCKET).upload(key, req.file.buffer, { contentType: req.file.mimetype, upsert: false })
  if (upErr) return res.status(500).json({ error: upErr.message })
  const caption = (req.body.caption || '').toString().slice(0, 2000)
  const { data, error: insErr } = await supabase.from('posts').insert({ id, caption, image_path: key }).select().single()
  if (insErr) return res.status(500).json({ error: insErr.message })
  const { data: url } = await supabase.storage.from(BUCKET).createSignedUrl(key, 3600)
  res.status(201).json({ ...data, signed_url: url?.signedUrl || null, like_count: 0 })
})

app.delete('/api/posts/:id', async (req, res) => {
  const { data: row, error: selErr } = await supabase.from('posts').select('image_path').eq('id', req.params.id).single()
  if (selErr) return res.status(404).json({ error: 'not_found' })
  await supabase.storage.from(BUCKET).remove([row.image_path])
  await supabase.from('post_comments').delete().eq('post_id', req.params.id)
  await supabase.from('post_likes').delete().eq('post_id', req.params.id)
  const { error: delErr } = await supabase.from('posts').delete().eq('id', req.params.id)
  if (delErr) return res.status(500).json({ error: delErr.message })
  res.json({ ok: true })
})

app.post('/api/posts/:id/like', async (req, res) => {
  const id = nanoid()
  const { error } = await supabase.from('post_likes').insert({ id, post_id: req.params.id, count: 1 })
  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true })
})

app.get('/api/posts/:id/comments', async (req, res) => {
  const { data, error } = await supabase
    .from('post_comments')
    .select('id, body, created_at')
    .eq('post_id', req.params.id)
    .order('created_at', { ascending: true })
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

app.post('/api/posts/:id/comments', async (req, res) => {
  const id = nanoid()
  const body = (req.body.body || '').toString().slice(0, 500)
  if (!body) return res.status(400).json({ error: 'empty' })
  const { data, error } = await supabase.from('post_comments').insert({ id, post_id: req.params.id, body }).select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.status(201).json(data)
})

app.get('*', (req, res) => {
  const file = path.join(__dirname, 'index.html')
  if (fs.existsSync(file)) res.sendFile(file)
  else res.status(404).send('index.html not found')
})

app.listen(PORT, () => console.log(`Listening on ${PORT}`))
