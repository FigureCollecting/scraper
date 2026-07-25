import request from 'supertest';
import app from '../../../index';

describe('Inter-Service Integration: Backend-Scraper Communication', () => {

  describe('Generic Scraping Endpoint', () => {
    it('should reject a scrape request with an invalid URL', async () => {
      const invalidPayload = {
        url: 'invalid-url',
        config: { nameSelector: '.name' }
      };

      const response = await request(app)
        .post('/scrape')
        .send(invalidPayload)
        .expect(400);

      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('message');
    });
  });

  describe('Service Health and Versioning', () => {
    it('should return health check information', async () => {
      const response = await request(app)
        .get('/health')
        .expect(200);

      expect(response.body).toHaveProperty('status', 'healthy');
      expect(response.body).toHaveProperty('service', 'scraper');
      expect(response.body).toHaveProperty('version');
      expect(typeof response.body.version).toBe('string');
    });

    it('should return version information', async () => {
      const response = await request(app)
        .get('/version')
        .expect(200);

      expect(response.body).toHaveProperty('name', 'scraper');
      expect(response.body).toHaveProperty('version');
      expect(response.body).toHaveProperty('status', 'ok');
    });
  });
});
