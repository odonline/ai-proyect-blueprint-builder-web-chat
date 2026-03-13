const express = require('express')
const router = express.Router()

router.get('/', (req, res) => {
    res.render('index-v2')
})

module.exports = router