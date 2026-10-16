const form = document.querySelector('#login-form');
const error = document.querySelector('#login-error');
document.querySelector('#transport-warning').hidden = location.protocol === 'https:';
form.addEventListener('submit', async (event) => {
  event.preventDefault(); const button = form.querySelector('button'); button.disabled = true; error.hidden = true;
  try {
    const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: form.elements.username.value, password: form.elements.password.value }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Sign-in failed');
    form.elements.password.value = ''; location.replace('/');
  } catch (caught) { error.textContent = caught.message; error.hidden = false; }
  finally { button.disabled = false; }
});
