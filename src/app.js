const express = require('express')
const path = require('path')

const app = express()

app.set('view engine', 'ejs')
app.set('views', path.join(__dirname, '../views'))
app.use(express.static(path.join(__dirname, '../public')))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Routes
app.use('/', require('./routes/index'))
app.use('/api/chat', require('./routes/chat.v2'))
app.use('/api/download', require('./routes/download'))

module.exports = app
