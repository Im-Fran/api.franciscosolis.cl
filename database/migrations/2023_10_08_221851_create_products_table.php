<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        Schema::create('products', function (Blueprint $table) {
            $table->string('name');
            $table->string('slug');
            $table->foreignUlid('user_id')->constrained();
            $table->string('compatible_systems');
            $table->json('compatible_versions');
            $table->string('license')->nullable();
            $table->json('access_requirements');
            $table->json('links')->nullable();
            $table->json('supported_languages');
            $table->string('product_icon')->nullable();
            $table->string('product_banner')->nullable();
            $table->softDeletes();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('products');
    }
};
