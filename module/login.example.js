// Copy to module/login.js on each server and set real values locally (file is gitignored).
const path = require('path');
const session = require('express-session');
const bodyParser = require('body-parser');

function setupLogin(app) {
  app.use(bodyParser.urlencoded({ extended: true }));
  app.use(session({
    secret: process.env.TRACKING_SESSION_SECRET || 'CHANGE_ME_SESSION_SECRET',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
  }));

  function checkAuth(req, res, next) {
    if (req.session.loggedIn) next();
    else res.redirect('/login');
  }

  app.get('/', (req, res) => {
    if (req.session.loggedIn) res.redirect('/index.html');
    else res.redirect('/login');
  });

  app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, '../html/login.html'));
  });

  app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const validUsername = process.env.TRACKING_LOGIN_USER || 'CHANGE_ME';
    const validPassword = process.env.TRACKING_LOGIN_PASS || 'CHANGE_ME';
    if (username === validUsername && password === validPassword) {
      req.session.loggedIn = true;
      res.redirect('/index.html');
    } else {
      res.send('Invalid username or password');
    }
  });

  app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
  });

  return checkAuth;
}

module.exports = setupLogin;
