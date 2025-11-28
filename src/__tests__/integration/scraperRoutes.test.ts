import request from 'supertest';
import express from 'express';
import cors from 'cors';
import { jest } from '@jest/globals';
import scraperRoutes from '../../routes/scraper';
import * as genericScraper from '../../services/genericScraper';

// Mock the genericScraper module
jest.mock('../../services/genericScraper');

const mockedGenericScraper = genericScraper as jest.Mocked<typeof genericScraper> & { SITE_CONFIGS: Record<string, any> };

describe('Scraper Routes Integration Tests', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(cors());
    app.use(express.json());
    app.use('/', scraperRoutes);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /scrape', () => {
    const validConfig = {
      imageSelector: '.image img',
      manufacturerSelector: '.manufacturer',
      nameSelector: '.product-name',
      scaleSelector: '.scale',
    };

    it('should successfully scrape with valid URL and config', async () => {
      const mockScrapedData = {
        imageUrl: 'https://example.com/image.jpg',
        manufacturer: 'Test Manufacturer',
        name: 'Test Product',
        scale: '1/8',
      };

      mockedGenericScraper.scrapeGeneric.mockResolvedValueOnce(mockScrapedData);

      const response = await request(app)
        .post('/scrape')
        .send({
          url: 'https://example.com/product',
          config: validConfig,
        })
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: mockScrapedData,
      });

      expect(mockedGenericScraper.scrapeGeneric).toHaveBeenCalledWith(
        'https://example.com/product',
        validConfig
      );
    });

    it('should return 400 if URL is missing', async () => {
      const response = await request(app)
        .post('/scrape')
        .send({
          config: validConfig,
        })
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        message: 'URL is required',
      });

      expect(mockedGenericScraper.scrapeGeneric).not.toHaveBeenCalled();
    });

    it('should return 400 if config is missing', async () => {
      const response = await request(app)
        .post('/scrape')
        .send({
          url: 'https://example.com/product',
        })
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        message: 'Config is required for generic scraping',
      });

      expect(mockedGenericScraper.scrapeGeneric).not.toHaveBeenCalled();
    });

    it('should return 400 for invalid URL format', async () => {
      const response = await request(app)
        .post('/scrape')
        .send({
          url: 'not-a-valid-url',
          config: validConfig,
        })
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        message: 'Invalid URL format',
      });

      expect(mockedGenericScraper.scrapeGeneric).not.toHaveBeenCalled();
    });

    it('should return 500 if scraping fails', async () => {
      const scrapingError = new Error('Scraping failed');
      mockedGenericScraper.scrapeGeneric.mockRejectedValueOnce(scrapingError);

      const response = await request(app)
        .post('/scrape')
        .send({
          url: 'https://example.com/product',
          config: validConfig,
        })
        .expect(500);

      expect(response.body).toEqual({
        success: false,
        message: 'Scraping failed',
        error: 'Scraping failed',
      });
    });

    it('should handle empty response from scraper', async () => {
      mockedGenericScraper.scrapeGeneric.mockResolvedValueOnce({});

      const response = await request(app)
        .post('/scrape')
        .send({
          url: 'https://example.com/product',
          config: validConfig,
        })
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: {},
      });
    });

    it('should handle partial data from scraper', async () => {
      const partialData = {
        imageUrl: 'https://example.com/image.jpg',
        // Missing other fields
      };

      mockedGenericScraper.scrapeGeneric.mockResolvedValueOnce(partialData);

      const response = await request(app)
        .post('/scrape')
        .send({
          url: 'https://example.com/product',
          config: validConfig,
        })
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: partialData,
      });
    });
  });

  describe('POST /scrape/mfc', () => {
    it('should successfully scrape MFC URL', async () => {
      const mockMFCData = {
        imageUrl: 'https://static.myfigurecollection.net/pics/figure/large/123456.jpg',
        manufacturer: 'Good Smile Company',
        name: 'Hatsune Miku',
        scale: '1/7',
      };

      mockedGenericScraper.scrapeMFC.mockResolvedValueOnce(mockMFCData);

      const response = await request(app)
        .post('/scrape/mfc')
        .send({
          url: 'https://myfigurecollection.net/item/123456',
        })
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: mockMFCData,
      });

      expect(mockedGenericScraper.scrapeMFC).toHaveBeenCalledWith(
        'https://myfigurecollection.net/item/123456',
        undefined
      );
    });

    it('should return 400 if URL is missing', async () => {
      const response = await request(app)
        .post('/scrape/mfc')
        .send({})
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        message: 'URL is required',
      });

      expect(mockedGenericScraper.scrapeMFC).not.toHaveBeenCalled();
    });

    it('should return 400 for invalid URL format', async () => {
      const response = await request(app)
        .post('/scrape/mfc')
        .send({
          url: 'not-a-valid-url',
        })
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        message: 'Invalid URL format',
      });

      expect(mockedGenericScraper.scrapeMFC).not.toHaveBeenCalled();
    });

    it('should return 400 for non-MFC URL', async () => {
      const response = await request(app)
        .post('/scrape/mfc')
        .send({
          url: 'https://example.com/product',
        })
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        message: 'URL must be from myfigurecollection.net domain',
      });

      expect(mockedGenericScraper.scrapeMFC).not.toHaveBeenCalled();
    });

    it('should reject URL bypass attempts (security fix for CodeQL alert)', async () => {
      // Test that subdomain attacks are properly rejected
      const bypassAttempts = [
        'https://myfigurecollection.net.evil.com/item/123', // Attacker's subdomain
        'https://evil.com/myfigurecollection.net/item/123', // MFC in path
        'https://fakemyfigurecollection.net/item/123', // Similar domain
      ];

      for (const url of bypassAttempts) {
        const response = await request(app)
          .post('/scrape/mfc')
          .send({ url })
          .expect(400);

        expect(response.body.success).toBe(false);
        expect(response.body.message).toContain('myfigurecollection.net');
        expect(mockedGenericScraper.scrapeMFC).not.toHaveBeenCalled();
      }
    });

    it('should accept various MFC URL formats', async () => {
      const mockData = { name: 'Test Figure' };
      mockedGenericScraper.scrapeMFC.mockResolvedValue(mockData);

      const validMFCUrls = [
        'https://myfigurecollection.net/item/123456',
        'http://myfigurecollection.net/item/123456',
        'https://www.myfigurecollection.net/item/123456',
        'https://myfigurecollection.net/browse/123456',
      ];

      for (const url of validMFCUrls) {
        await request(app)
          .post('/scrape/mfc')
          .send({ url })
          .expect(200);
      }

      expect(mockedGenericScraper.scrapeMFC).toHaveBeenCalledTimes(validMFCUrls.length);
    });

    it('should return 500 if MFC scraping fails', async () => {
      const scrapingError = new Error('MFC scraping failed');
      mockedGenericScraper.scrapeMFC.mockRejectedValueOnce(scrapingError);

      const response = await request(app)
        .post('/scrape/mfc')
        .send({
          url: 'https://myfigurecollection.net/item/123456',
        })
        .expect(500);

      expect(response.body).toEqual({
        success: false,
        message: 'MFC scraping failed',
        error: 'MFC scraping failed',
      });
    });
  });

  describe('GET /configs', () => {
    it('should return available site configurations', async () => {
      const mockSiteConfigs = {
        mfc: {
          imageSelector: '.item-picture .main img',
          manufacturerSelector: '.data-field .data-label:contains("Company") + .data-value .item-entries a span[switch]',
          nameSelector: '.data-field .data-label:contains("Character") + .data-value .item-entries a span[switch]',
          scaleSelector: '.item-scale',
          cloudflareDetection: {
            titleIncludes: ['Just a moment'],
            bodyIncludes: ['Just a moment'],
          },
          waitTime: 1000,
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        },
      };

      mockedGenericScraper.SITE_CONFIGS = mockSiteConfigs;

      const response = await request(app)
        .get('/configs')
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: mockSiteConfigs,
      });
    });

    it('should return configs even if empty', async () => {
      mockedGenericScraper.SITE_CONFIGS = {};

      const response = await request(app)
        .get('/configs')
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: {},
      });
    });
  });

  describe('Error handling middleware', () => {
    it('should handle malformed JSON in request body', async () => {
      const response = await request(app)
        .post('/scrape')
        .send('invalid json')
        .set('Content-Type', 'application/json')
        .expect(400);

      // Express should handle malformed JSON automatically
      expect(response.status).toBe(400);
    });

    it('should handle large request bodies gracefully', async () => {
      const largeConfig = {
        imageSelector: 'a'.repeat(10000),
        manufacturerSelector: 'b'.repeat(10000),
        nameSelector: 'c'.repeat(10000),
        scaleSelector: 'd'.repeat(10000),
      };

      mockedGenericScraper.scrapeGeneric.mockResolvedValueOnce({});

      const response = await request(app)
        .post('/scrape')
        .send({
          url: 'https://example.com/product',
          config: largeConfig,
        });

      // Should still work even with large selectors
      expect(response.status).toBe(200);
    });
  });

  describe('POST /reset-pool', () => {
    const originalEnv = process.env.NODE_ENV;
    const originalAdminToken = process.env.ADMIN_TOKEN;

    beforeEach(() => {
      // Set test environment
      process.env.NODE_ENV = 'test';
      process.env.ADMIN_TOKEN = 'test-admin-token';
    });

    afterEach(() => {
      // Restore original environment
      process.env.NODE_ENV = originalEnv;
      process.env.ADMIN_TOKEN = originalAdminToken;
    });

    it('should return 500 if ADMIN_TOKEN is not configured', async () => {
      // Temporarily remove ADMIN_TOKEN
      delete process.env.ADMIN_TOKEN;
      
      const response = await request(app)
        .post('/reset-pool')
        .set('x-admin-token', 'any-token')
        .expect(500);

      expect(response.body).toEqual({
        success: false,
        message: 'Server configuration error',
      });
      
      // Restore ADMIN_TOKEN for other tests
      process.env.ADMIN_TOKEN = 'test-admin-token';
    });

    it('should return 403 without authentication token', async () => {
      const response = await request(app)
        .post('/reset-pool')
        .expect(403);

      expect(response.body).toEqual({
        success: false,
        message: 'Forbidden',
      });
    });

    it('should return 403 with invalid authentication token', async () => {
      const response = await request(app)
        .post('/reset-pool')
        .set('x-admin-token', 'invalid-token')
        .expect(403);

      expect(response.body).toEqual({
        success: false,
        message: 'Forbidden',
      });
    });

    it('should successfully reset browser pool with valid token', async () => {
      // Mock BrowserPool.reset as async
      const mockReset = jest.fn().mockResolvedValue(undefined);
      mockedGenericScraper.BrowserPool = {
        reset: mockReset,
        initialize: jest.fn(),
        getBrowser: jest.fn(),
        closeAll: jest.fn(),
      } as any;

      const response = await request(app)
        .post('/reset-pool')
        .set('x-admin-token', 'test-admin-token')
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        message: 'Browser pool reset successfully',
      });

      expect(mockReset).toHaveBeenCalled();
    });

    it('should return 500 if pool reset fails', async () => {
      const resetError = new Error('Pool reset failed');
      const mockReset = jest.fn().mockRejectedValue(resetError);
      
      mockedGenericScraper.BrowserPool = {
        reset: mockReset,
        initialize: jest.fn(),
        getBrowser: jest.fn(),
        closeAll: jest.fn(),
      } as any;

      const response = await request(app)
        .post('/reset-pool')
        .set('x-admin-token', 'test-admin-token')
        .expect(500);

      expect(response.body).toEqual({
        success: false,
        message: 'Failed to reset browser pool',
      });
      expect(mockReset).toHaveBeenCalled();
      // Note: error details are no longer exposed
    });

    it('should not register endpoint in production environment', async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'production';

        const prodApp = express();
        prodApp.use(cors());
        prodApp.use(express.json());

        // Re-import router in isolation with mocks preserved
        jest.isolateModules(() => {
          jest.doMock('../../services/genericScraper'); // keep module mocked
          const prodRouter = require('../../routes/scraper').default;
          prodApp.use('/', prodRouter);
        });

        await request(prodApp)
          .post('/reset-pool')
          .set('x-admin-token', 'test-admin-token')
          .expect(404);
      } finally {
        // Always restore original environment
        process.env.NODE_ENV = originalNodeEnv;
      }
    });

    it('should handle pool reset with no errors even if pool is already reset', async () => {
      const mockReset = jest.fn().mockResolvedValue(undefined);
      mockedGenericScraper.BrowserPool = {
        reset: mockReset,
        initialize: jest.fn(),
        getBrowser: jest.fn(),
        closeAll: jest.fn(),
      } as any;

      // Call reset multiple times with auth
      await request(app).post('/reset-pool').set('x-admin-token', 'test-admin-token').expect(200);
      await request(app).post('/reset-pool').set('x-admin-token', 'test-admin-token').expect(200);
      await request(app).post('/reset-pool').set('x-admin-token', 'test-admin-token').expect(200);

      expect(mockReset).toHaveBeenCalledTimes(3);
    });
  });

  describe('CORS handling', () => {
    it('should include CORS headers', async () => {
      const response = await request(app)
        .options('/scrape')
        .expect(204);

      expect(response.headers['access-control-allow-origin']).toBe('*');
    });

    it('should handle preflight requests', async () => {
      const response = await request(app)
        .options('/scrape/mfc')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'Content-Type')
        .expect(204);

      expect(response.headers).toHaveProperty('access-control-allow-methods');
    });
  });
});