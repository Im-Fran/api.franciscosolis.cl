<?php

namespace App\Http\Middleware\Content;

use Closure;
use Illuminate\Http\Request;

class HandleLocaleMiddleware {
    public function handle(Request $request, Closure $next) {
        app()->setLocale($request->header('Accept-Language', 'en'));

        return $next($request);
    }
}
