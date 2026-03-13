require('dotenv').config()
const app = require('./src/app')

const PORT = process.env.PORT || 3200
app.listen(PORT, () => {
  console.log(`\n🚀 Proyect Blueprint Builder running at http://localhost:${PORT}\n`)
})

