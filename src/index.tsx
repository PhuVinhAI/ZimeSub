import { render } from 'solid-js/web'
import App from './App'
import './index.css'

const root = document.getElementById('root')
if (!root) {
  throw new Error('ZimeSub: #root element missing from index.html')
}

render(() => <App />, root)
