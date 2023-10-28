<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class() extends Migration {
    public function up(): void {
        Schema::create('products', function(Blueprint $table) {
            $table->id();
            $table->string('name');
            $table->string('slug');
            $table->ulidMorphs('owned_by');
            $table->string('compatible_systems');
            $table->json('compatible_versions')->default('[]');
            $table->string('license')->nullable();
            $table->json('access_requirements')->default('[]');
            $table->json('links')->default('[]');
            $table->json('supported_languages')->default('[]');
            $table->string('product_icon')->nullable();
            $table->string('product_banner')->nullable();
            $table->softDeletes();
            $table->timestamps();
        });
    }

    public function down(): void {
        Schema::dropIfExists('products');
    }
};
