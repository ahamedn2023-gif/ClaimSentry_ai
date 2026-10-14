
import { api } from './api.js';
import { $, el, clear, bytes, spinner } from './dom.js';

const form = $('#claim-form');
const submitBtn = $('#submit-btn');
const formError = $('#form-error');
const healthBox = $('#health');

async function boot() {
  try {
    const [meta, health] = await Promise.all([
      api.get('/api/departments'),
      api.get('/api/health')
    ]);

    const select = $('#claimType');
    select.replaceChildren();

    for (const type of meta.claimTypes || []) {
      select.append(
        el('option', {
          value: type,
          text: type.replace(/_/g, ' ')
        })
      );
    }

    healthBox.textContent = health.aiConfigured
      ? `AI document examiner online (${health.model}).`
      : 'Rules-only assessment is available.';
  } catch (error) {
    healthBox.textContent = `Service check failed: ${error.message}`;
  }
}

$('#documents').addEventListener('change', event => {
  const files = Array.from(event.target.files || []);
  const total = files.reduce((sum, file) => sum + file.size, 0);

  clear($('#file-list')).append(
    ...files.map(file =>
      el('div', {
        text: `${file.name} — ${bytes(file.size)}`
      })
    ),
    el('div', {
      text: `${files.length} file(s), ${bytes(total)} total`
    })
  );
});

form.addEventListener('submit', async event => {
  event.preventDefault();

  clear(formError);
  formError.classList.add('hidden');

  if (!form.reportValidity()) return;

  const files = Array.from($('#documents').files || []);
  const consent = $('#aiConsent');

  if (files.length > 6) {
    formError.textContent = 'You can upload up to 6 files.';
    formError.className = 'notice error';
    return;
  }

  if (files.some(file => file.size > 8 * 1024 * 1024)) {
    formError.textContent = 'Each file must be 8 MB or smaller.';
    formError.className = 'notice error';
    return;
  }

  const total = files.reduce((sum, file) => sum + file.size, 0);

  if (total > 16 * 1024 * 1024) {
    formError.textContent = 'The total upload size must not exceed 16 MB.';
    formError.className = 'notice error';
    return;
  }

  // The backend must independently enforce consent before calling Gemini.
  const data = new FormData(form);
  data.set('aiConsent', consent.checked ? 'true' : 'false');
  data.delete('documents');

  for (const file of files) {
    data.append('documents', file);
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Submitting…';

  try {
    const result = await api.postForm('/api/claims', data);

    clear($('#result-body')).append(
      el('div', {
        class: 'notice ok',
        text: 'Claim submitted successfully.'
      }),
      el('div', { class: 'card' }, [
        el('h2', { text: 'Claim reference' }),
        el('p', { text: result.reference || 'Reference unavailable' }),
        el('h3', { text: 'Tracking code' }),
        el('p', {
          text: result.trackingSecret || result.secret ||
            'No tracking code was returned. Contact the administrator.'
        }),
        el('p', {
          text: result.departmentName
            ? `Department: ${result.departmentName}`
            : 'Your claim has been received for review.'
        })
      ])
    );

    $('#view-form').classList.add('hidden');
    $('#view-result').classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) {
    formError.textContent =
      error.message || 'Claim submission failed. Please try again.';
    formError.className = 'notice error';
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit claim';
  }
});

boot();
