<?php

namespace App\Http\Controllers\Products;

use App\Http\Controllers\Controller;
use App\Http\Resources\Products\ProductResource;
use App\Models\Products\Product;
use Illuminate\Http\Request;

class ProductController extends Controller {
    public function index() {
        return ProductResource::collection(Product::all());
    }

    public function store(Request $request) {
        $request->validate([
            'name' => ['required'],
            'slug' => ['required'],
            'user_id' => ['required', 'integer'],
            'compatible_systems' => ['required'],
            'compatible_versions' => ['required'],
            'license' => ['nullable'],
            'access_requirements' => ['required'],
            'links' => ['nullable'],
            'supported_languages' => ['required'],
            'product_icon' => ['nullable'],
            'product_banner' => ['nullable'],
        ]);

        return new ProductResource(Product::create($request->validated()));
    }

    public function show(Product $product) {
        return new ProductResource($product);
    }

    public function update(Request $request, Product $product) {
        $request->validate([
            'name' => ['required'],
            'slug' => ['required'],
            'user_id' => ['required', 'integer'],
            'compatible_systems' => ['required'],
            'compatible_versions' => ['required'],
            'license' => ['nullable'],
            'access_requirements' => ['required'],
            'links' => ['nullable'],
            'supported_languages' => ['required'],
            'product_icon' => ['nullable'],
            'product_banner' => ['nullable'],
        ]);

        $product->update($request->validated());

        return new ProductResource($product);
    }

    public function destroy(Product $product) {
        $product->delete();

        return response()->json();
    }
}
