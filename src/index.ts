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
				return new Response(null, { status: 405 });
		}
	},
};

const handleGet = async (request: Request, env: Env): Promise<Response> => {
	try {
		// Coba ambil dari query parameter dulu
		const url = new URL(request.url);
		let albumUrl = url.searchParams.get('url')?.trim();

		// Kalo ga ada query parameter atau cuma ID pendek, coba format
		if (albumUrl) {
			// Kalo cuma ID pendek (contoh: 7QzAnueaCVnrQdiG7)
			if (!albumUrl.startsWith('http')) {
				albumUrl = `https://photos.app.goo.gl/${albumUrl}`;
			}
		} else {
			// Fallback ke env variable
			albumUrl = env.ALBUM_URL?.trim();
		}

		if (!albumUrl) {
			return jsonResponse(
				{
					error: 'ALBUM_URL not set. Provide ?url= parameter or set env variable',
					examples: {
						env_var: 'GET https://your-worker.workers.dev/',
						query_param: 'GET https://your-worker.workers.dev/?url=https://photos.app.goo.gl/7QzAnueaCVnrQdiG7',
						short_id: 'GET https://your-worker.workers.dev/?url=7QzAnueaCVnrQdiG7'
					}
				},
				{ status: 400, allowOrigin: env.ALLOW_ORIGIN }
			);
		}

		// Follow redirect untuk short URL
		const finalUrl = await resolveShortUrl(albumUrl);
		
		// Fetch album page
		const resp = await fetch(`${finalUrl}?_imcp=1`, { 
			redirect: 'follow',
			headers: {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
			}
		});
		
		const text = await resp.text();

		// Ambil title dari meta og:title atau title tag
		let title = 'Unknown Album';
		const titleMatch = text.match(/<title>(.*?)<\/title>/);
		if (titleMatch) {
			title = titleMatch[1].replace(/\s*-\s*Google\s*Photos\s*$/i, '').trim();
		}

		// Regex untuk match gambar dan video
		const mediaMatches = [
			...text.matchAll(
				/\["(https:\/\/lh3\.googleusercontent\.com\/pw\/[a-zA-Z0-9_-]+)",(\d+),(\d+)[^\]]+\][^\]]+\]\],(\d+),[^,]+,[^,]+,(\d+),(\d+),\[(\d+),(\d+)\]/g
			),
		];

		// Process each media item
		const mediaItems = mediaMatches.map((match) => {
			const [, baseUrl, width, height, createdTimestamp, updatedTimestamp, isVideo, videoWidth, videoHeight] = match;
			
			// Cek apakah ini video (biasanya isVideo = 1 untuk video)
			if (isVideo === '1') {
				// Ini video - generate multiple resolutions
				const baseFile = baseUrl.replace(/=w\d+-h\d+(-[a-z]+)?$/, '');
				
				return {
					title: title, // Bisa improved dengan extract judul per video kalo ada
					status: true,
					sources: [
						{
							file: `${baseFile}=m37`,
							label: '1080p',
							type: 'video/mp4'
						},
						{
							file: `${baseFile}=m22`,
							label: '720p',
							type: 'video/mp4'
						},
						{
							file: `${baseFile}=m18`,
							label: '360p',
							type: 'video/mp4'
						}
					],
					image: `${baseUrl}=w1280-h720-no`,
					host: 'googlephotos',
					vtt: null,
					width: Number(width),
					height: Number(height),
					createdTimestamp: Number(createdTimestamp),
					updatedTimestamp: Number(updatedTimestamp)
				};
			} else {
				// Ini gambar - generate multiple sizes
				const baseFile = baseUrl.replace(/=w\d+-h\d+(-[a-z]+)?$/, '');
				
				return {
					url: baseUrl,
					width: Number(width),
					height: Number(height),
					createdTimestamp: Number(createdTimestamp),
					updatedTimestamp: Number(updatedTimestamp),
					sources: [
						{
							url: `${baseFile}=w1080-h1080-no`,
							label: '1080p',
							width: 1080,
							height: Math.round((Number(height) / Number(width)) * 1080)
						},
						{
							url: `${baseFile}=w720-h720-no`,
							label: '720p',
							width: 720,
							height: Math.round((Number(height) / Number(width)) * 720)
						},
						{
							url: `${baseFile}=w360-h360-no`,
							label: '360p',
							width: 360,
							height: Math.round((Number(height) / Number(width)) * 360)
						}
					]
				};
			}
		});

		// Deduplikasi berdasarkan URL
		const uniqueMedia = [...new Map(mediaItems.map((item) => {
			const key = item.sources ? item.sources[0]?.url || item.url : item.image;
			return [key, item];
		})).values()];

		// Hitung statistik
		const videos = uniqueMedia.filter(item => item.sources && !item.url);
		const images = uniqueMedia.filter(item => item.url);

		const response = {
			title: title,
			media: uniqueMedia,
			statistics: {
				total: uniqueMedia.length,
				videos: videos.length,
				images: images.length
			},
			albumUrl: finalUrl,
			originalUrl: albumUrl,
			fetchedAt: new Date().toISOString()
		};

		return jsonResponse(
			response,
			{
				status: 200,
				allowOrigin: env.ALLOW_ORIGIN,
				extraHeaders: { 
					'Cache-Control': env.CACHE_CONTROL || 'max-age=604800, stale-while-revalidate',
					'X-Total-Count': uniqueMedia.length.toString()
				}
			}
		);

	} catch (error: any) {
		return jsonResponse(
			{ 
				error: 'Failed to fetch album', 
				message: error.message,
				stack: error.stack 
			},
			{ status: 500, allowOrigin: env.ALLOW_ORIGIN }
		);
	}
};

// Fungsi untuk resolve short URL
const resolveShortUrl = async (url: string): Promise<string> => {
	try {
		// Kalo udah long URL, return as is
		if (url.includes('photos.google.com')) {
			return url;
		}

		// Follow redirect untuk short URL
		const resp = await fetch(url, { 
			method: 'HEAD',
			redirect: 'manual'
		});

		if (resp.status >= 300 && resp.status < 400) {
			const location = resp.headers.get('location');
			if (location) {
				return location;
			}
		}
		
		return url;
	} catch {
		return url;
	}
};

const jsonResponse = (data: any, params: { status?: number; allowOrigin?: string; extraHeaders?: Record<string, string> }) => {
	return new Response(JSON.stringify(data, null, 2), {
		status: params.status || 200,
		headers: { 
			'content-type': 'application/json', 
			'Access-Control-Allow-Origin': params.allowOrigin || '*', 
			...params.extraHeaders 
		},
	});
};

const handleOptions = async (env: Env): Promise<Response> => {
	return new Response(null, {
		status: 204,
		headers: {
			Allow: 'GET, OPTIONS',
			'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
			'Access-Control-Allow-Methods': 'GET, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
			'Access-Control-Max-Age': '86400',
		},
	});
};
