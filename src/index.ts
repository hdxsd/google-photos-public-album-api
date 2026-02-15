/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Env {
	ALBUM_URL?: string;
	ALLOW_ORIGIN?: string;
	CACHE_CONTROL?: string;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		switch (request.method) {
			case 'GET':
				return handleGet(request, env);
			case 'OPTIONS':
				return handleOptions(env);
			default:
				return new Response(null, { 
					status: 405,
					headers: {
						'Allow': 'GET, OPTIONS',
						'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
					}
				});
		}
	},
};

const handleGet = async (request: Request, env: Env): Promise<Response> => {
	try {
		// Coba ambil dari query parameter dulu
		const url = new URL(request.url);
		let queryAlbumUrl = url.searchParams.get('url');
		
		// Kalo query parameter cuma ID doang (format: 7QzAnueaCVnrQdiG7)
		if (queryAlbumUrl && !queryAlbumUrl.includes('http')) {
			queryAlbumUrl = `https://photos.app.goo.gl/${queryAlbumUrl}`;
		}
		
		// Fallback ke env variable kalo ga ada query parameter
		const albumUrl = queryAlbumUrl?.trim() || env.ALBUM_URL?.trim();

		if (!albumUrl) {
			return jsonResponse(
				{ 
					error: 'ALBUM_URL not set. Provide ?url= parameter or set env variable',
					title: null,
					images: [],
					count: 0,
					albumUrl: null,
					fetchedAt: new Date().toISOString()
				}, 
				{ 
					status: 400, // Lebih tepat pakai 400 daripada 500
					allowOrigin: env.ALLOW_ORIGIN 
				}
			);
		}

		// Validasi URL
		try {
			new URL(albumUrl);
		} catch {
			return jsonResponse(
				{ 
					error: 'Invalid album URL format',
					title: null,
					images: [],
					count: 0,
					albumUrl,
					fetchedAt: new Date().toISOString()
				}, 
				{ 
					status: 400, 
					allowOrigin: env.ALLOW_ORIGIN 
				}
			);
		}

		// Fetch album page dengan timeout
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 detik timeout

		try {
			const resp = await fetch(`${albumUrl}?_imcp=1`, { 
				redirect: 'follow',
				headers: {
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'Accept-Language': 'en-US,en;q=0.5',
				},
				signal: controller.signal
			});

			if (!resp.ok) {
				throw new Error(`Failed to fetch album: ${resp.status} ${resp.statusText}`);
			}

			const text = await resp.text();

			// Extract album title from <title> tag
			let title = null;
			const titleMatch = text.match(/<title>(.+?)<\/title>/);
			if (titleMatch) {
				title = titleMatch[1]
					.replace(/ - Google Photos$/, '')
					.replace(/&amp;/g, '&')
					.trim();
			}

			// Regex yang lebih komprehensif untuk video
			const videoPatterns = [
				// Pattern 1: Array format dengan video
				/\["(https:\/\/lh3\.googleusercontent\.com\/pw\/[a-zA-Z0-9_\/-]+)",(\d+),(\d+)[^\]]*video[^\]]*\]/gi,
				
				// Pattern 2: Object format
				/"url":"(https:\/\/lh3\.googleusercontent\.com\/pw\/[a-zA-Z0-9_\/-]+)","width":(\d+),"height":(\d+)[^}]*"mimeType":"video\/mp4"/gi,
				
				// Pattern 3: Direct video references
				/\[(\d+),(\d+),\["(https:\/\/lh3\.googleusercontent\.com\/pw\/[a-zA-Z0-9_\/-]+)"[^\]]*video/gi
			];

			const videos = new Map(); // Gunakan Map untuk deduplikasi

			// Coba semua pattern
			for (const pattern of videoPatterns) {
				const matches = text.matchAll(pattern);
				for (const match of matches) {
					// Pattern yang berbeda punya posisi URL yang berbeda
					const url = match[1] || match[3];
					if (!url || videos.has(url)) continue;

					// Ambil dimensi dari posisi yang sesuai
					let width = 1920, height = 1080;
					
					if (match[2] && match[3]) {
						// Pattern 1: width di [2], height di [3]
						if (match[1]) { 
							width = parseInt(match[2]);
							height = parseInt(match[3]);
						}
						// Pattern 2: width di [2], height di [3] (sudah benar)
						else if (match[2] && !isNaN(parseInt(match[2]))) {
							width = parseInt(match[2]);
							height = parseInt(match[3]);
						}
					}

					videos.set(url, { baseUrl: url, width, height });
				}
			}

			// Fallback: cari semua URL video dengan konteks
			if (videos.size === 0) {
				const urlRegex = /(https:\/\/lh3\.googleusercontent\.com\/pw\/[a-zA-Z0-9_\/-]+)/g;
				const allUrls = [...new Set(text.match(urlRegex) || [])];
				
				for (const url of allUrls) {
					if (videos.has(url)) continue;
					
					// Cek konteks sekitar URL untuk menentukan apakah ini video
					const contextStart = Math.max(0, text.indexOf(url) - 200);
					const contextEnd = Math.min(text.length, text.indexOf(url) + 200);
					const context = text.substring(contextStart, contextEnd);
					
					if (context.includes('video') || context.includes('mp4') || context.includes('mimeType')) {
						// Coba cari dimensi di konteks
						const dimMatch = context.match(/(\d+)[, ]+(\d+)/);
						videos.set(url, {
							baseUrl: url,
							width: dimMatch ? parseInt(dimMatch[1]) : 1920,
							height: dimMatch ? parseInt(dimMatch[2]) : 1080
						});
					}
				}
			}

			// Konversi ke array dan buat output
			const videoList = Array.from(videos.entries()).map(([baseUrl, video]) => {
				// Generate thumbnail
				const thumbnail = `${video.baseUrl}=w1280-h720-no`;
				
				// Tentukan resolusi berdasarkan tinggi
				const resolutions = [];
				if (video.height >= 1080) {
					resolutions.push('m37', 'm22', 'm18'); // 1080p, 720p, 360p
				} else if (video.height >= 720) {
					resolutions.push('m22', 'm18'); // 720p, 360p
				} else {
					resolutions.push('m18'); // 360p
				}
				
				// Buat sources
				const sources = resolutions.map(res => ({
					file: `${video.baseUrl}=${res}`,
					label: res === 'm37' ? '1080p' : res === 'm22' ? '720p' : '360p',
					type: 'video/mp4'
				}));
				
				return {
					title: title || 'Untitled Video',
					status: true,
					sources,
					image: thumbnail,
					host: 'googlephotos',
					vtt: null,
					original: {
						width: video.width,
						height: video.height
					}
				};
			});

			// Sortir videos (opsional, misalnya berdasarkan ukuran)
			videoList.sort((a, b) => {
				const aSize = a.original?.height || 0;
				const bSize = b.original?.height || 0;
				return bSize - aSize; // Descending
			});

			const response = {
				title,
				images: videoList,
				count: videoList.length,
				albumUrl,
				fetchedAt: new Date().toISOString(),
				status: videoList.length > 0 ? 'success' : 'empty'
			};

			return jsonResponse(
				response,
				{
					status: 200,
					allowOrigin: env.ALLOW_ORIGIN,
					extraHeaders: { 
						'Cache-Control': env.CACHE_CONTROL || 'public, max-age=604800, stale-while-revalidate=86400',
						'X-Video-Count': videoList.length.toString()
					},
				}
			);

		} finally {
			clearTimeout(timeoutId);
		}

	} catch (error) {
		console.error('Error fetching album:', error);
		
		const status = error.name === 'AbortError' ? 504 : 500;
		const message = error.name === 'AbortError' 
			? 'Request timeout' 
			: error.message || 'Internal server error';

		return jsonResponse(
			{ 
				error: message,
				title: null,
				images: [],
				count: 0,
				albumUrl: null,
				fetchedAt: new Date().toISOString()
			}, 
			{ 
				status, 
				allowOrigin: env.ALLOW_ORIGIN 
			}
		);
	}
};

const jsonResponse = (data: any, params: { status?: number; allowOrigin?: string; extraHeaders?: Record<string, string> }) => {
	return new Response(JSON.stringify(data, null, 2), {
		status: params.status || 200,
		headers: { 
			'Content-Type': 'application/json', 
			'Access-Control-Allow-Origin': params.allowOrigin || '*',
			'X-Content-Type-Options': 'nosniff',
			...params.extraHeaders 
		},
	});
};

const handleOptions = async (env: Env): Promise<Response> => {
	return new Response(null, {
		status: 204,
		headers: {
			'Allow': 'GET, OPTIONS',
			'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
			'Access-Control-Allow-Methods': 'GET, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type, Accept',
			'Access-Control-Max-Age': '86400',
			'Access-Control-Expose-Headers': 'X-Video-Count',
		},
	});
};
