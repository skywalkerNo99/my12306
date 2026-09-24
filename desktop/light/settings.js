connection.load().then(value => {
  document.querySelector('#url').value = value.url;
  document.querySelector('#username').value = value.username;
  document.querySelector('#url').readOnly = value.authentication;
  document.querySelector('#auth').hidden = !value.authentication;
  if (value.authentication) document.querySelector('#hint').textContent = '公网入口要求验证身份。请输入现有 Prefect 公网入口的账号和密码。密码不保存到磁盘。';
});
document.querySelector('form').addEventListener('submit', async e => {
  e.preventDefault();
  try { await connection.save(Object.fromEntries(['url', 'username', 'password'].map(key => [key, document.getElementById(key).value]))); }
  catch (error) { document.querySelector('#error').textContent = error.message; }
});
