'use strict';

const { app, api, request, registerUser, DEFAULT_USER } = require('./helpers');

describe('Authentication', () => {
  describe('POST /auth/signup', () => {
    it('creates an account and returns a token pair', async () => {
      const response = await request(app).post(api('/auth/signup')).send(DEFAULT_USER).expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data.user.email).toBe('test@paisa.app');
      expect(response.body.data.accessToken).toEqual(expect.any(String));
      expect(response.body.data.refreshToken).toEqual(expect.any(String));
      expect(response.body.data.tokenType).toBe('Bearer');
    });

    it('never returns the password hash', async () => {
      const response = await request(app).post(api('/auth/signup')).send(DEFAULT_USER).expect(201);
      expect(response.body.data.user).not.toHaveProperty('password');
      expect(JSON.stringify(response.body)).not.toContain('$2a$');
    });

    it('rejects a duplicate email with 409', async () => {
      await registerUser();
      const response = await request(app).post(api('/auth/signup')).send(DEFAULT_USER).expect(409);
      expect(response.body.error.code).toBe('CONFLICT');
    });

    it('rejects a weak password with field-level detail', async () => {
      const response = await request(app)
        .post(api('/auth/signup'))
        .send({ ...DEFAULT_USER, password: 'short' })
        .expect(422);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.details.some((d) => d.field === 'body.password')).toBe(true);
    });

    it('normalises the email to lower case', async () => {
      const response = await request(app)
        .post(api('/auth/signup'))
        .send({ ...DEFAULT_USER, email: 'MiXeD@Paisa.App' })
        .expect(201);

      expect(response.body.data.user.email).toBe('mixed@paisa.app');
    });
  });

  describe('POST /auth/login', () => {
    it('authenticates valid credentials', async () => {
      await registerUser();
      const response = await request(app)
        .post(api('/auth/login'))
        .send({ email: DEFAULT_USER.email, password: DEFAULT_USER.password })
        .expect(200);

      expect(response.body.data.accessToken).toEqual(expect.any(String));
    });

    it('rejects a wrong password', async () => {
      await registerUser();
      const response = await request(app)
        .post(api('/auth/login'))
        .send({ email: DEFAULT_USER.email, password: 'Wrong@12345' })
        .expect(401);

      expect(response.body.message).toBe('Invalid email or password');
    });

    it('gives an unknown email the same message as a wrong password', async () => {
      // Identical responses are what stop this endpoint enumerating accounts.
      const response = await request(app)
        .post(api('/auth/login'))
        .send({ email: 'nobody@paisa.app', password: 'Whatever@123' })
        .expect(401);

      expect(response.body.message).toBe('Invalid email or password');
    });
  });

  describe('Protected routes', () => {
    it('rejects a request with no token', async () => {
      const response = await request(app).get(api('/expenses')).expect(401);
      expect(response.body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects a malformed token', async () => {
      const response = await request(app)
        .get(api('/expenses'))
        .set('Authorization', 'Bearer not.a.jwt')
        .expect(401);

      expect(response.body.error.code).toBe('TOKEN_INVALID');
    });

    it('accepts a valid token', async () => {
      const { auth } = await registerUser();
      const response = await request(app).get(api('/auth/me')).set(auth).expect(200);
      expect(response.body.data.user.email).toBe(DEFAULT_USER.email);
    });
  });

  describe('Session management', () => {
    it('exchanges a refresh token for a new pair', async () => {
      const { refreshToken } = await registerUser();
      const response = await request(app).post(api('/auth/refresh')).send({ refreshToken }).expect(200);
      expect(response.body.data.accessToken).toEqual(expect.any(String));
    });

    it('refuses to use an access token as a refresh token', async () => {
      const { accessToken } = await registerUser();
      await request(app).post(api('/auth/refresh')).send({ refreshToken: accessToken }).expect(401);
    });

    it('invalidates existing sessions after logout', async () => {
      const { auth, refreshToken } = await registerUser();
      await request(app).post(api('/auth/logout')).set(auth).expect(200);

      // The refresh token was minted before the revocation stamp.
      await request(app).post(api('/auth/refresh')).send({ refreshToken }).expect(401);
    });

    it('changes the password and rejects the old one', async () => {
      const { auth } = await registerUser();

      await request(app)
        .post(api('/auth/change-password'))
        .set(auth)
        .send({ currentPassword: DEFAULT_USER.password, newPassword: 'BrandNew@2026' })
        .expect(200);

      await request(app)
        .post(api('/auth/login'))
        .send({ email: DEFAULT_USER.email, password: DEFAULT_USER.password })
        .expect(401);

      await request(app)
        .post(api('/auth/login'))
        .send({ email: DEFAULT_USER.email, password: 'BrandNew@2026' })
        .expect(200);
    });

    it('updates profile preferences', async () => {
      const { auth } = await registerUser();
      const response = await request(app)
        .patch(api('/auth/me'))
        .set(auth)
        .send({ name: 'Renamed User', preferences: { budgetAlertThreshold: 0.6 } })
        .expect(200);

      expect(response.body.data.user.name).toBe('Renamed User');
      expect(response.body.data.user.preferences.budgetAlertThreshold).toBe(0.6);
    });
  });
});
